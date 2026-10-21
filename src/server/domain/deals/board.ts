// Доски (B8): сделки по этапам воронки и вид «Обзвон» для РОП. Только чтение: перенос сделки делает маршрут
// B6 (`POST /api/deals/[id]/stage`), итог по карточке — `POST /api/calls/outcomes` с `via: 'manual_entry'`.
// Что видно — решает охват (`deal.read`, `card.read`) в SQL; проекция полей — по роли, как в карточке клиента.
import { fields } from '@crm/core';
import { BadRequestError, ForbiddenError, NotFoundError, can, scopeOf, type Viewer } from '@/server/access';
import { fieldViewer, loadClientsConfig, type ClientsConfig } from '@/server/domain/clients';
import { ConfigMissingError } from '@/server/platform/config/active';
import { getDb } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import { formatKzPhone, maskKzPhone } from '@/shared/tel';
import { boardDeps } from './boardDeps';
import { missingFor, staleDaysOf } from './boardRules';
import {
  countCallingClosed,
  countCallingColumns,
  countClosedDeals,
  countDealColumns,
  selectCallingCards,
  selectCallingWorkers,
  selectClosedDeals,
  selectDealColumnPage,
  selectDealOwners,
  selectDealWindow,
  selectWorkingPhones,
  type CallingRow,
  type DealRow,
} from './boardRepo';
import {
  CALLING_COLUMNS,
  type BoardColumn,
  type BoardFieldDef,
  type BoardStage,
  type CallingBoard,
  type CallingColumn,
  type CallingState,
  type CallingTile,
  type ClosedDeals,
  type DealTile,
  type DealTileField,
  type DealsBoard,
} from './boardTypes';
import type { DealPipelineInfo, DealStageInfo } from './types';

/** Плиток в колонке за один раз (дизайн §4.2). */
export const COLUMN_PAGE = 50;

const CURSOR = /^(\d{1,16}):([A-Za-z0-9_-]{1,64})$/;

export function parseCursor(raw: string | null | undefined): { at: number; id: string } | null {
  if (!raw) return null;
  const m = CURSOR.exec(raw);
  if (!m) throw new BadRequestError('cursor');
  return { at: Number(m[1]), id: m[2]! };
}

const cursorOf = (at: number, id: string): string => `${at}:${id}`;

/** Настройки полей; нет ревизии настроек — полей на плитках нет (fail closed, не 500 на доске). */
async function fieldsConfigOrNull(viewer: Viewer): Promise<ClientsConfig | null> {
  try {
    return await loadClientsConfig(viewer);
  } catch (e) {
    if (e instanceof ConfigMissingError) return null;
    throw e;
  }
}

const writable = (viewer: Viewer, perm: 'deal.edit' | 'deal.move_back' | 'deal.purchase' | 'card.outcome'): boolean => !viewer.readOnly && can(viewer, perm);

/** Пространство запроса; доски под флагом `FEATURE_KANBAN` — выключен, значит их нет (404). */
function spaceOf(viewer: Viewer): string {
  if (!isFeatureEnabled('KANBAN') || viewer.spaceId === null) throw new NotFoundError();
  return viewer.spaceId;
}

function pickPipeline(pipelines: readonly DealPipelineInfo[], key: string | null): DealPipelineInfo {
  const p = key === null ? pipelines[0] : pipelines.find((x) => x.key === key);
  if (!p) throw new NotFoundError();
  return p;
}

/** К обязательным полям этапа добавляются поля, у которых `required.onStage` называет этот этап. */
export function withStageFields(stages: readonly DealStageInfo[], defs: readonly fields.FieldDef[]): DealStageInfo[] {
  return stages.map((s) => {
    const extra = defs.filter((d) => d.object === 'deal' && !d.archived && d.required.onStage.includes(s.key)).map((d) => d.key);
    if (extra.length === 0) return s;
    return { ...s, requires: { ...s.requires, fields: [...new Set([...s.requires.fields, ...extra])] } };
  });
}

const FIELD_FORM_TYPES = new Set(['text', 'textarea', 'number', 'money', 'date', 'select']);

/** Поля, которые просит хоть один открытый этап, — для панели «Переместить» (подписи, варианты, можно ли править). */
function fieldDefsFor(stages: readonly DealStageInfo[], cfg: ClientsConfig | null, viewer: Viewer): BoardFieldDef[] {
  if (!cfg) return [];
  const fv = fieldViewer(viewer, cfg);
  const keys = new Set(stages.filter((s) => s.kind === 'open').flatMap((s) => s.requires.fields));
  return cfg.fields
    .filter((d) => d.object === 'deal' && keys.has(d.key))
    .map((d) => ({
      key: d.key,
      label: d.label.ru,
      type: (FIELD_FORM_TYPES.has(d.type) ? d.type : 'text') as BoardFieldDef['type'],
      options: d.options.filter((o) => !o.archived).map((o) => ({ key: o.key, label: o.label.ru })),
      editable: fields.resolveAccess(d, fv) === 'edit',
    }));
}

function displayValue(def: fields.FieldDef, value: unknown): unknown {
  if (def.type === 'select' && typeof value === 'string') return def.options.find((o) => o.key === value)?.label.ru ?? value;
  if (def.type === 'multiselect' && Array.isArray(value)) return value.map((k) => def.options.find((o) => o.key === k)?.label.ru ?? k).join(', ');
  return value;
}

interface TileCtx {
  stages: readonly DealStageInfo[];
  cfg: ClientsConfig | null;
  viewer: Viewer;
  now: number;
  canClient: boolean;
  withMissing: boolean;
}

function tileFields(row: DealRow, ctx: TileCtx): DealTileField[] {
  if (!ctx.cfg) return [];
  const fv = fieldViewer(ctx.viewer, ctx.cfg);
  const out: DealTileField[] = [];
  const add = (object: 'deal' | 'client', values: Record<string, unknown>) => {
    const proj = fields.projectFor(fv, object, ctx.cfg!.fields, values as fields.CustomValues);
    for (const f of proj.fields) {
      if (out.length >= 2) return;
      if (!f.showOn.kanban || f.value === null) continue;
      const def = ctx.cfg!.fields.find((d) => d.object === object && d.key === f.key);
      out.push({ key: f.key, label: f.label.ru, value: def ? displayValue(def, f.value) : f.value });
    }
  };
  add('deal', row.custom ?? {});
  add('client', row.clientCustom ?? {});
  return out;
}

function toTile(row: DealRow, ctx: TileCtx): DealTile {
  const stage = ctx.stages.find((s) => s.key === row.stageKey);
  const missing: Record<string, DealTile['missing'][string]> = {};
  if (ctx.withMissing) {
    const filled = new Set(Object.entries(row.custom ?? {}).filter(([, v]) => !fields.isEmptyValue(v)).map(([k]) => k));
    const facts = { hasBooking: row.hasBooking, hasAttendance: row.hasAttendance, hasNextTask: row.taskDueAt !== null, filled };
    for (const s of ctx.stages) if (s.kind === 'open') missing[s.key] = missingFor(s, facts);
  }
  return {
    id: row.id,
    version: row.version,
    stageKey: row.stageKey,
    stageChangedAt: row.stageChangedAt,
    clientId: row.clientId,
    clientName: row.clientName,
    contactName: ctx.canClient ? row.contactName : null,
    phone: ctx.canClient && row.phone ? formatKzPhone(row.phone) : null,
    fields: tileFields(row, ctx),
    nextTask: row.taskId ? { id: row.taskId, dueAt: row.taskDueAt, title: row.taskTitle ?? '' } : null,
    ownerName: row.ownerName,
    badges: { needsRebook: row.needsRebook, staleDays: staleDaysOf({ status: row.status, stageChangedAt: row.stageChangedAt }, stage, ctx.now) },
    missing,
  };
}

async function context(viewer: Viewer, pipelineKey: string | null) {
  const spaceId = spaceOf(viewer);
  const deps = boardDeps();
  const now = deps.now();
  const cfg = await fieldsConfigOrNull(viewer);
  const pipelines = await deps.pipelines(spaceId);
  const base = pickPipeline(pipelines, pipelineKey);
  const stages = withStageFields(base.stages, cfg?.fields ?? []);
  const tile: TileCtx = { stages, cfg, viewer, now, canClient: can(viewer, 'client.read'), withMissing: true };
  return { spaceId, now, cfg, pipelines, pipeline: base, stages, tile };
}

const stageView = (s: DealStageInfo): BoardStage => ({ key: s.key, label: s.label.ru, kind: s.kind, order: s.order, staleDays: s.staleDays });

const ownerOf = (owner: string | null | undefined): string | null => (owner && owner !== 'all' ? owner : null);

/** Доска сделок: открытые колонки (до 50 плиток), счётчики, закрытые за 30 суток, сотрудники и права на действия. */
export async function getDealsBoard(viewer: Viewer, q: { pipeline?: string | null; owner?: string | null } = {}): Promise<DealsBoard> {
  const c = await context(viewer, q.pipeline ?? null);
  const sql = (await getDb()).sql;
  const args = { spaceId: c.spaceId, pipelineKey: c.pipeline.key, owner: ownerOf(q.owner) };
  const [rows, counts, closed, owners] = await Promise.all([
    selectDealWindow(viewer, sql, { ...args, limit: COLUMN_PAGE }),
    countDealColumns(viewer, sql, args),
    countClosedDeals(viewer, sql, { ...args, now: c.now }),
    selectDealOwners(viewer, sql, { spaceId: c.spaceId, pipelineKey: c.pipeline.key }),
  ]);
  const total = new Map(counts.map((x) => [x.stageKey, x.n]));
  const columns: BoardColumn[] = c.stages
    .filter((s) => s.kind === 'open')
    .map((s) => {
      const deals = rows.filter((r) => r.stageKey === s.key).map((r) => toTile(r, c.tile));
      const n = total.get(s.key) ?? 0;
      const last = deals[deals.length - 1];
      return { stageKey: s.key, total: n, deals, nextCursor: last && n > deals.length ? cursorOf(last.stageChangedAt, last.id) : null };
    });
  return {
    pipeline: { key: c.pipeline.key, label: c.pipeline.label.ru, stages: c.stages.map(stageView) },
    pipelines: c.pipelines.map((p) => ({ key: p.key, label: p.label.ru })),
    columns,
    closed: { won30d: closed.won, lost30d: closed.lost },
    owners,
    fieldDefs: fieldDefsFor(c.stages, c.cfg, viewer),
    can: { edit: writable(viewer, 'deal.edit'), moveBack: writable(viewer, 'deal.move_back'), purchase: writable(viewer, 'deal.purchase'), lose: writable(viewer, 'deal.edit') },
  };
}

/** «Ещё» в колонке: следующие 50 открытых сделок этапа после курсора. */
export async function getDealsColumn(viewer: Viewer, q: { pipeline?: string | null; stage: string; owner?: string | null; after: string | null }): Promise<BoardColumn> {
  const c = await context(viewer, q.pipeline ?? null);
  const stage = c.stages.find((s) => s.key === q.stage && s.kind === 'open');
  if (!stage) throw new NotFoundError();
  const after = parseCursor(q.after) ?? { at: -1, id: '' };
  const sql = (await getDb()).sql;
  const args = { spaceId: c.spaceId, pipelineKey: c.pipeline.key, owner: ownerOf(q.owner) };
  const [rows, counts] = await Promise.all([
    selectDealColumnPage(viewer, sql, { ...args, stageKey: stage.key, afterAt: after.at, afterId: after.id, limit: COLUMN_PAGE + 1 }),
    countDealColumns(viewer, sql, args),
  ]);
  const page = rows.slice(0, COLUMN_PAGE).map((r) => toTile(r, c.tile));
  const last = page[page.length - 1];
  return { stageKey: stage.key, total: counts.find((x) => x.stageKey === stage.key)?.n ?? 0, deals: page, nextCursor: rows.length > COLUMN_PAGE && last ? cursorOf(last.stageChangedAt, last.id) : null };
}

/** Закрытые сделки (только чтение): 50 последних выигранных и проигранных, дальше — по курсору. */
export async function getClosedDeals(viewer: Viewer, q: { pipeline?: string | null; owner?: string | null; before: string | null }): Promise<ClosedDeals> {
  const c = await context(viewer, q.pipeline ?? null);
  const before = parseCursor(q.before);
  const sql = (await getDb()).sql;
  const rows = await selectClosedDeals(viewer, sql, {
    spaceId: c.spaceId,
    pipelineKey: c.pipeline.key,
    owner: ownerOf(q.owner),
    beforeAt: before?.at ?? null,
    beforeId: before?.id ?? null,
    limit: COLUMN_PAGE + 1,
  });
  const tileCtx: TileCtx = { ...c.tile, withMissing: false };
  const page = rows.slice(0, COLUMN_PAGE);
  const last = page[page.length - 1];
  return {
    deals: page.map((r) => ({ ...toTile(r, tileCtx), status: r.status as 'won' | 'lost' })),
    nextCursor: rows.length > COLUMN_PAGE && last ? cursorOf(last.closedAt, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Вид «Обзвон»
// ---------------------------------------------------------------------------

/** Вид «Обзвон» — для охвата пространства (РОП, директор): чужие карточки оператора на нём не показываем. */
function assertSpaceScope(viewer: Viewer): void {
  const scope = scopeOf(viewer, 'card.read');
  if (scope !== 'space' && scope !== 'all') throw new ForbiddenError();
}

async function toCallingTiles(viewer: Viewer, rows: readonly CallingRow[]): Promise<CallingTile[]> {
  const sql = (await getDb()).sql;
  const phones = await selectWorkingPhones(viewer, sql, [...new Set(rows.map((r) => r.clientId))]);
  return rows.map((r) => ({
    cardId: r.id,
    version: r.version,
    state: r.state,
    clientId: r.clientId,
    clientName: r.clientName,
    workerId: r.workerId,
    workerName: r.workerName,
    attempts: r.attempts,
    nextCallAt: r.nextCallAt,
    lastOutcomeCode: r.lastOutcomeCode,
    lastOutcomeAt: r.lastOutcomeAt,
    decisionMakerId: r.decisionMakerId,
    phones: phones.filter((p) => p.clientId === r.clientId).map((p) => ({ id: p.id, masked: maskKzPhone(p.digits) })),
  }));
}

/** Вид «Обзвон» для РОП: карточки с владельцем по состояниям `new`, `retry`, `callback`, `agreed` и счётчик закрытых. */
export async function getCallingBoard(viewer: Viewer, q: { worker?: string | null } = {}): Promise<CallingBoard> {
  const spaceId = spaceOf(viewer);
  assertSpaceScope(viewer);
  const now = boardDeps().now();
  const sql = (await getDb()).sql;
  const args = { spaceId, worker: ownerOf(q.worker) };
  const [counts, closed, workers, ...lists] = await Promise.all([
    countCallingColumns(viewer, sql, args),
    countCallingClosed(viewer, sql, { ...args, now }),
    selectCallingWorkers(viewer, sql, { spaceId }),
    ...CALLING_COLUMNS.map((state) => selectCallingCards(viewer, sql, { ...args, state, offset: 0, limit: COLUMN_PAGE })),
  ]);
  const columns: CallingColumn[] = [];
  for (const [i, state] of CALLING_COLUMNS.entries()) {
    const cards = await toCallingTiles(viewer, lists[i]!);
    const total = counts.find((x) => x.state === state)?.n ?? 0;
    columns.push({ state, total, cards, nextOffset: total > cards.length ? cards.length : null });
  }
  const moveScope = scopeOf(viewer, 'card.outcome');
  return { columns, closed, workers, can: { move: !viewer.readOnly && (moveScope === 'space' || moveScope === 'all') } };
}

/** «Ещё» в колонке обзвона: следующие 50 карточек, начиная с `offset` (порядок колонки стабилен). */
export async function getCallingColumn(viewer: Viewer, q: { state: string; worker?: string | null; offset: number }): Promise<CallingColumn> {
  const spaceId = spaceOf(viewer);
  assertSpaceScope(viewer);
  if (!(CALLING_COLUMNS as readonly string[]).includes(q.state)) throw new NotFoundError();
  const state = q.state as CallingState;
  const sql = (await getDb()).sql;
  const args = { spaceId, worker: ownerOf(q.worker) };
  const [rows, counts] = await Promise.all([
    selectCallingCards(viewer, sql, { ...args, state, offset: q.offset, limit: COLUMN_PAGE }),
    countCallingColumns(viewer, sql, args),
  ]);
  const cards = await toCallingTiles(viewer, rows);
  const total = counts.find((x) => x.state === state)?.n ?? 0;
  const loaded = q.offset + cards.length;
  return { state, total, cards, nextOffset: total > loaded ? loaded : null };
}
