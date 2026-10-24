// Сервис клиентов: карточка, список, правка полей, выживший при слиянии, лента (PROCESS 8.3, 9).
// Права и охват — в repo.ts (scopeSql); здесь — порядок действий и проверки значений.
import { calling, fields, names } from '@crm/core';
import { BadRequestError, can, ConflictError, NotFoundError, type Viewer } from '@/server/access';
import { getDb, isUniqueViolation, type Sql } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import { iinHmac } from '@/server/platform/hmac';
import { getClientSummary, listClientDeals, listFeed, parseFilter, parseGroups, readPinnedNotes, PIN_LIMIT, type ClientSummaryDto, type DealRowDto, type FeedPage, type NoteDto } from '../timeline';
import { appendEvents, dealOfClientVisible, type NewEvent } from '../timeline/repo';
import { loadBoardHead, toCardBoard } from './boardHead';
import { cardFieldViewer } from './cardFields';
import { loadCatalogLabels, type CatalogLabels } from './labels';
import { fieldViewer, loadClientsConfig, type ClientsConfig } from './config';
import { pickDecisionMaker, pickPrimaryPhone, toCardHead, toContactDto, toPhoneDto } from './dto';
import { FieldIssuesError } from './errors';
import { hiddenIdAction } from './hiddenId';
import { SEARCH_LIMIT, LIST_LIMIT, decodeCursor, encodeCursor, parseFeedLimit, type ListQuery, type PatchBody } from './input';
import {
  iinTakenBy,
  insertIinReviewTask,
  lockClientForEdit,
  lockIntake,
  selectCardHead,
  selectClient,
  selectClientList,
  selectContacts,
  selectPhones,
  selectSurvivor,
  selectWorkingPhones,
  throwNotFoundOrForbidden,
  updateClient as updateClientRow,
} from './repo';
import { refreshSearchNorm } from './searchNorm';
import type { CardState, ClientCardDto, ClientList, ClientRow } from './types';

/** Пустое значение системного поля сравнивается как «нет»: '' и null — одно и то же. */
export function sameSystemValue(a: unknown, b: unknown): boolean {
  const x = a === '' || a === undefined ? null : a;
  const y = b === '' || b === undefined ? null : b;
  return x === y;
}

// ---------- Карточка ----------

/** № 14: из каких состояний карточка возвращается в обзвон. */
/** Состояния, из которых форма покупки открывается; повторяет PURCHASE_STATES в deals (там константа не экспортируется — зона deals). */
const PURCHASE_FROM: readonly string[] = ['agreed', 'callback', 'client'];
const REOPEN_FROM: readonly string[] = ['not_target', 'written_off', 'not_interested'];

/** № 11, 12 из меню: «Не целевой» или «Полный отказ» допустимы из этих состояний (таблица ядра). */
function canCloseFrom(state: string): boolean {
  const from = calling.OUTCOME_ALLOWED_FROM;
  return from.not_target.includes(state as CardState) || (state !== 'do_not_call' && from.do_not_call.includes(state as CardState));
}

/** Карточка клиента (4.1–4.4). Слитый клиент и невидимый — NotFoundError. */
export async function getClientCard(viewer: Viewer, id: string, cfgIn?: ClientsConfig): Promise<ClientCardDto> {
  const cfg = cfgIn ?? (await loadClientsConfig(viewer));
  const fv = fieldViewer(viewer, cfg);
  const db = await getDb();
  const row = await selectClient(db.sql, viewer, id);
  if (!row || row.mergedIntoId !== null) throw new NotFoundError();
  const [head, phoneRows, contactRows] = await Promise.all([
    selectCardHead(db.sql, viewer, id),
    selectPhones(db.sql, viewer, id),
    selectContacts(db.sql, viewer, id),
  ]);
  const phones = phoneRows.map(toPhoneDto);
  const boardHead = head ? await loadBoardHead(viewer) : null;
  const contacts = contactRows.map((c) => toContactDto(c, fv, cfg.fields));
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    legalForm: row.legalForm,
    orgId: row.orgId,
    region: row.region,
    address: row.address,
    email: row.email,
    emailHref: fields.mailtoHref(row.email),
    website: row.website,
    websiteHref: fields.safeHttpUrl(row.website),
    sourceKind: row.sourceKind,
    updatedAt: row.updatedAt,
    can: {
      edit: row.canEdit,
      editIdentity: row.canIdentity,
      editCard: head?.canEditCard ?? false,
      note: !viewer.readOnly && can(viewer, 'note.write'),
      book: head ? head.canBook && (head.state === 'agreed' || head.state === 'client') : false,
      // Задача (B7): нужно право записи задач и карточка в пространстве (задача привязана к клиенту карточки)
      task: head !== null && !viewer.readOnly && can(viewer, 'task.write'),
      // C9: право по карточке (охват в SQL, «только чтение» уже понижено) и допустимое состояние ядра
      closeFromMenu: head ? head.canClose && canCloseFrom(head.state) : false,
      reopen: head ? head.canReopen && REOPEN_FROM.includes(head.state) : false,
      unblock: head ? head.canUnblock && head.state === 'do_not_call' : false,
      // B9a: право передачи по карточке (охват в SQL, «только чтение» уже понижено)
      transfer: head ? head.canTransfer : false,
      // C7: открытая сделка в охвате `deal.purchase`, состояние допускает покупку, раздел покупок включён, «только чтение» — нет
      purchase: head ? head.canPurchase && PURCHASE_FROM.includes(head.state) && isFeatureEnabled('PURCHASES') && !viewer.readOnly : false,
    },
    card: head
      ? toCardHead(
          head,
          fields.projectFor(cardFieldViewer(viewer, cfg), 'card', cfg.fields, head.custom as fields.CustomValues),
          boardHead ? toCardBoard(head, boardHead, viewer.grants.has('deal.read')) : null,
        )
      : null,
    phones,
    primaryPhone: pickPrimaryPhone(phones),
    decisionMaker: pickDecisionMaker(contacts),
    contacts,
    contactFields: fields.projectFor(fv, 'contact', cfg.fields, {}),
    fields: fields.projectFor(fv, 'client', cfg.fields, row.custom as fields.CustomValues),
  };
}

export type ClientPage =
  | {
      kind: 'ok';
      card: ClientCardDto;
      feed: FeedPage;
      legalForms: ClientsConfig['legalFormOptions'];
      summary: ClientSummaryDto;
      pinnedNotes: NoteDto[];
      deals: DealRowDto[];
      catalog: CatalogLabels;
    }
  | { kind: 'redirect'; to: string }
  | { kind: 'missing' };

/** Данные страницы: слитый клиент ведёт к выжившему (если он виден), иначе страницы нет. */
export async function loadClientPage(viewer: Viewer, id: string): Promise<ClientPage> {
  const cfg = await loadClientsConfig(viewer);
  const db = await getDb();
  const row = await selectClient(db.sql, viewer, id);
  if (!row || row.mergedIntoId !== null) {
    // Карточка слитого клиента переезжает к выжившему и самому слитому уже не видна: ищем по цепочке,
    // а охват проверяем у выжившего. Не виден никто — страницы нет (как у несуществующего id).
    const survivor = await selectSurvivor(db.sql, viewer, id);
    return survivor && survivor !== id ? { kind: 'redirect', to: `/clients/${survivor}` } : { kind: 'missing' };
  }
  const card = await getClientCard(viewer, id, cfg);
  const [feed, summary, pinnedNotes, deals, catalog] = await Promise.all([
    listFeed(viewer, id, { cursor: null, groups: null, fields: cfg.fields, fieldViewer: fieldViewer(viewer, cfg) }),
    getClientSummary(
      viewer,
      id,
      card.card && {
        state: card.card.state,
        nextCallAt: card.card.nextCallAt,
        nextCallPrecision: card.card.nextCallPrecision,
        callsTotal: card.card.counters.callsTotal,
        connectsTotal: card.card.counters.connectsTotal,
        noAnswerTotal: card.card.counters.noAnswerTotal,
        ownerName: card.card.ownerName,
        actingName: card.card.actingName,
      },
    ),
    readPinnedNotes(db.sql, viewer, id, PIN_LIMIT),
    listClientDeals(viewer, id),
    loadCatalogLabels(viewer),
  ]);
  return { kind: 'ok', card, feed, legalForms: cfg.legalFormOptions, summary, pinnedNotes, deals, catalog };
}

/** Итоговый отчёт по клиенту; клиент не виден — 404. */
export async function getClientSummaryFor(viewer: Viewer, id: string): Promise<ClientSummaryDto> {
  const db = await getDb();
  const row = await selectClient(db.sql, viewer, id);
  if (!row || row.mergedIntoId !== null) throw new NotFoundError();
  const head = await selectCardHead(db.sql, viewer, id);
  return getClientSummary(viewer, id, head);
}

/** История сделок клиента; клиент не виден — 404. */
export async function getClientDeals(viewer: Viewer, id: string): Promise<DealRowDto[]> {
  const db = await getDb();
  const row = await selectClient(db.sql, viewer, id);
  if (!row || row.mergedIntoId !== null) throw new NotFoundError();
  return listClientDeals(viewer, id);
}

export async function findSurvivor(viewer: Viewer, id: string): Promise<string | null> {
  const db = await getDb();
  const s = await selectSurvivor(db.sql, viewer, id);
  return s && s !== id ? s : null;
}

/** Страница ленты клиента: сначала видимость карточки (не виден — 404, а не пустая лента). */
export async function getClientFeed(
  viewer: Viewer,
  id: string,
  raw: { cursor: string | null; groups: string | null; group?: string | null; dealId?: string | null; limit?: string | null },
): Promise<FeedPage> {
  const limit = parseFeedLimit(raw.limit);
  const cfg = await loadClientsConfig(viewer);
  const db = await getDb();
  const row = await selectClient(db.sql, viewer, id);
  if (!row || row.mergedIntoId !== null) throw new NotFoundError();
  // Лента сделки: сделку проверяем тем же охватом до чтения, чужая или несуществующая — 404
  const dealId = raw.dealId ? raw.dealId : null;
  if (dealId !== null && !(await dealOfClientVisible(db.sql, viewer, id, dealId))) throw new NotFoundError();
  return listFeed(viewer, id, {
    cursor: decodeCursor(raw.cursor),
    groups: parseGroups(raw.groups),
    filter: parseFilter(raw.group ?? null),
    dealId,
    limit,
    fields: cfg.fields,
    fieldViewer: fieldViewer(viewer, cfg),
  });
}

// ---------- Список ----------

/** Значение фильтра поля → фрагмент `custom @>`; поле скрытое, не фильтруемое или значение плохое — 400. */
function filterEntry(cfg: ClientsConfig, fv: fields.FieldViewer, key: string, raw: string): [string, fields.FieldValue] {
  const def = fields.filterableField(cfg.fields, 'client', fv, key);
  if (!def) throw new BadRequestError('field_filter');
  const input: unknown = def.type === 'multiselect' ? [raw] : def.type === 'datetime' ? Number(raw) : raw;
  const c = fields.coerceValue(def, input, { phoneRules: cfg.phoneRules });
  if (!c.ok || c.value === null) throw new BadRequestError('field_filter');
  return [key, c.value];
}

export async function listClients(viewer: Viewer, q: ListQuery): Promise<ClientList> {
  const cfg = await loadClientsConfig(viewer);
  const fv = fieldViewer(viewer, cfg);
  const search = fields.parseSearchQuery(q.q);
  if (search.kind === 'short') return { items: [], next: null, hint: 'short' };
  const filter: Record<string, fields.FieldValue> = {};
  for (const f of q.fieldFilters) {
    const [key, value] = filterEntry(cfg, fv, f.key, f.value);
    filter[key] = value;
  }
  const searching = search.kind !== 'none';
  const limit = Math.min(q.limit ?? (searching ? SEARCH_LIMIT : LIST_LIMIT), searching ? SEARCH_LIMIT : LIST_LIMIT);
  const p1 = search.kind === 'none' ? null : (search.patterns[0] ?? null);
  const p2 = search.kind === 'none' ? null : (search.patterns[1] ?? p1);
  const db = await getDb();
  const rows = await selectClientList(db.sql, viewer, { states: q.states, p1, p2, filter, cursor: q.cursor, limit, view: q.view, owner: q.owner });
  const page = rows.slice(0, limit);
  const phones = await selectWorkingPhones(db.sql, viewer, page.map((r) => r.id));
  const primary = new Map<string, string>();
  for (const p of phones) if (!primary.has(p.clientId)) primary.set(p.clientId, `+${p.digits}`);
  const items: ClientRow[] = page.map((r) => ({
    id: r.id,
    cardId: r.cardId,
    name: r.name,
    state: r.state as CardState,
    holdReason: r.holdReason,
    nextCallAt: r.nextCallAt,
    lastTouchAt: r.lastTouchAt,
    primaryPhone: primary.get(r.id) ?? null,
    values: listValues(cfg, fv, r.custom),
    closeReasonCode: r.closeReasonCode,
    closedAt: r.closedAt,
    returnAt: r.returnAt,
  }));
  const last = page[page.length - 1];
  return { items, next: rows.length > limit && last ? encodeCursor({ at: last.sortAt, id: last.cardId }) : null };
}

/** Значения полей `showOn.list`, видимых сотруднику. */
function listValues(cfg: ClientsConfig, fv: fields.FieldViewer, custom: Record<string, unknown>): Record<string, fields.FieldValue> {
  const onList = new Set(cfg.fields.filter((f) => f.object === 'client' && f.showOn.list).map((f) => f.key));
  const visible = fields.projectValues(fv, 'client', cfg.fields, custom as fields.CustomValues);
  return Object.fromEntries(Object.entries(visible).filter(([k]) => onList.has(k)));
}

// ---------- Правка ----------

export type Issues = readonly fields.FieldIssue[];

/** Проверка `expect` (D-124): значения, которые видел интерфейс, должны совпасть с текущими. */
export function assertExpected(
  body: PatchBody,
  currentSystem: Record<string, unknown>,
  currentCustom: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(body.expect.system ?? {})) {
    if (!sameSystemValue(currentSystem[k], v)) throw new ConflictError();
  }
  for (const [k, v] of Object.entries(body.expect.custom ?? {})) {
    const cur = Object.hasOwn(currentCustom, k) ? (currentCustom[k] as fields.FieldValue) : null;
    const exp = v === undefined || v === '' ? null : (v as fields.FieldValue | null);
    if (!fields.sameValue(cur, exp)) throw new ConflictError();
  }
}

export function changeEvents(
  obj: 'client' | 'contact',
  clientId: string,
  contactId: string | null,
  sys: readonly fields.FieldChange[],
  custom: readonly fields.FieldChange[],
): NewEvent[] {
  const mk = (isSys: boolean) => (c: fields.FieldChange): NewEvent => ({
    clientId,
    kind: 'field.changed',
    refType: contactId ? 'contact' : '',
    refId: contactId ?? '',
    data: { obj, sys: isSys, field: c.key, before: c.before, after: c.after, ...(contactId ? { contactId } : {}) },
  });
  return [...sys.map(mk(true)), ...custom.map(mk(false))];
}

/** Правка затрагивает уникальные ключи клиента (БИН, ИИН) — её надо упорядочить с приёмом (D-126). */
function touchesOrgKeys(body: PatchBody): boolean {
  const sys = body.set.system ?? {};
  return Object.hasOwn(sys, 'org_id') || Object.hasOwn(sys, 'legal_form');
}

/**
 * PATCH клиента (5.1). Порядок: [блокировка приёма, если меняются БИН/форма] → блокировка с охватом →
 * проверка значений (права на поля, типы) → сверка `expect` → запись и события в одной транзакции. Нет
 * изменений — ни записи, ни событий. 12 цифр, которые могут быть ИИН, пишутся только как HMAC (D-181).
 * Скрытый номер (D-192): очистка номера и переход на «не личную» форму сбрасывают `iin_hmac`; ИИН, уже
 * записанный другому клиенту, не пишется и уходит задачей РОП, а ответ тот же, что при записи: занятость
 * ИИН наружу не видна (409 остаётся только у открытого БИН).
 */
export async function updateClient(viewer: Viewer, id: string, body: PatchBody): Promise<ClientCardDto> {
  const cfg = await loadClientsConfig(viewer);
  const fv = fieldViewer(viewer, cfg);
  const db = await getDb();
  try {
    await db.tx(async (sql: Sql) => {
      // Порядок блокировок един для всех путей: INTAKE_LOCK_KEY → строка клиента. Иначе правка, ждущая
      // уникальный БИН незавершённой партии, и партия, дописывающая этого клиента, ждут друг друга.
      if (touchesOrgKeys(body)) await lockIntake(sql);
      const row = await lockClientForEdit(sql, viewer, id);
      if (!row) return throwNotFoundOrForbidden(viewer, sql, 'client', id);
      const currentSystem: Record<string, unknown> = {
        name: row.name,
        legal_form: row.legalForm,
        org_id: row.orgId,
        region: row.region,
        address: row.address,
        email: row.email,
        website: row.website,
      };
      const ctx = { phoneRules: cfg.phoneRules };
      const sys = fields.validateSystemPatch({
        object: 'client',
        patch: body.set.system ?? {},
        current: currentSystem as Record<string, fields.FieldValue>,
        can: { identity: row.canIdentity, edit: true },
        legalForms: cfg.legalForms,
        ctx,
        clientKind: row.kind,
        ...(cfg.personIdRule === 'kz_iin_hmac' ? { personalIdHmac: (d: string) => iinHmac(d) } : {}),
      });
      const cv = fields.buildFieldValidator({ fields: cfg.fields, object: 'client', mode: 'user', viewer: fv, ctx }).validate(
        body.set.custom ?? {},
        row.custom as fields.CustomValues,
      );
      const issues = [...sys.errors, ...cv.errors];
      if (issues.length > 0) throw new FieldIssuesError(issues);
      assertExpected(body, currentSystem, row.custom);
      const hidden = hiddenIdAction({
        patch: body.set.system ?? {},
        hiddenId: sys.hiddenId,
        current: { legalForm: row.legalForm, hasHiddenId: row.hasHiddenId },
        clientKind: row.kind,
        legalForms: cfg.legalForms,
      });
      if (sys.changes.length + cv.changes.length === 0 && hidden.kind === 'keep') return;
      // Занятый ИИН: строка всё равно обновляется (тот же updatedAt и те же события, что при записи)
      const twinId = hidden.kind === 'set' ? await iinTakenBy(sql, hidden.hmac, id) : null;

      const col = (k: string): string | null => {
        const v = sys.columns[k];
        return typeof v === 'string' ? v : null;
      };
      const newName = col('name');
      const ok = await updateClientRow(
        sql,
        viewer,
        id,
        {
          name: newName,
          legalForm: col('legal_form'),
          orgId: col('org_id'),
          region: col('region'),
          address: col('address'),
          email: col('email'),
          website: col('website'),
          nameNorm: newName === null ? null : names.normalizeCompanyName(newName, cfg.namesForms),
          iinHmac: hidden.kind === 'set' && twinId === null ? hidden.hmac : null,
          clearIinHmac: hidden.kind === 'clear',
        },
        cv.next,
      );
      if (!ok) throw new ConflictError();
      if (twinId !== null) await insertIinReviewTask(sql, viewer, { clientId: id, twinId });
      await appendEvents(sql, viewer, changeEvents('client', id, null, sys.changes, cv.changes));
      await refreshSearchNorm(sql, viewer, id, cfg);
    });
  } catch (e) {
    // Занятый БИН: clients_org_uq. ИИН проверен заранее под блокировкой приёма (D-192); сюда он попадает
    // только при гонке с путём, который этой блокировки не берёт. Транзакция откачена, событий нет.
    if (isUniqueViolation(e)) throw new ConflictError();
    throw e;
  }
  return getClientCard(viewer, id, cfg);
}
