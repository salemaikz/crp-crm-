// Мир интеграционных тестов обзвона: синтетика изоляции + настоящие настройки (ревизия в БД), часы, зависимости
// записи с настоящим портом карточки. Среда 28.10.2026 11:00 (Алматы); четверг 29.10 — праздник для сценария календаря.
import type { JsonObject } from '@crm/core/config';
import { createCardBookingPort } from '../../../src/server/domain/cards/bookingPort';
import { loadCallingContext } from '../../../src/server/domain/cards/settings';
import type { CallsDeps, OutcomeRequest } from '../../../src/server/domain/calls';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { Sql } from '../../../src/server/platform/db';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { makeDeps, testSettings, type TestClock } from '../booking/helpers';
import { worldConfig } from '../clients/world';
import { closeWorld, openWorld } from '../access/world';
import { SEED_NOW } from '../../isolation/harness/seed';

export { SEED_NOW };
export { viewerOf, enterSeedWorld } from '../../isolation/harness/actors';
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const uuid = (): string => globalThis.crypto.randomUUID();

const t = (ru: string): JsonObject => ({ ru });
const stage = (key: string, kind: string, order: number, auto: string | null): JsonObject => ({
  key,
  label: t(key),
  kind,
  order,
  requires: { fields: [], booking: false, attendance: false, nextTask: false, amount: false, serviceType: false, reason: false },
  staleDays: null,
  auto,
});

/** Настройки мира: итоги minimal, воронка с этапами записи и явки, 29.10 — праздник, поле шторки «ниша». */
export function callsConfig(): { global: JsonObject; spaces: Record<string, JsonObject> } {
  const c = worldConfig();
  const g = c.global as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- документ правится по путям
  g.calendar.holidays = [
    { date: '2026-01-01', kind: 'holiday', note: '' },
    { date: '2026-10-29', kind: 'holiday', note: '' },
  ];
  const niche = {
    key: 'niche',
    object: 'client',
    type: 'select',
    label: t('Ниша'),
    options: [{ key: 'trade', label: t('Торговля') }, { key: 'service', label: t('Услуги') }],
    access: {},
    required: { always: false, onOutcome: [], onStage: [] },
    searchable: false,
    filterable: false,
    ingest: false,
    pii: 'none',
    showOn: { card: true, kanban: false, list: false },
  };
  g.fields = [...(g.fields as JsonObject[]), niche];
  const sp = c.spaces.sales as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  sp.pipelines = [
    {
      key: 'sales',
      kind: 'sales',
      label: t('Продажи'),
      createDealOn: 'agreed',
      stages: [stage('booked', 'open', 0, 'on_agreed'), stage('attended', 'open', 1, 'on_attended'), stage('paid', 'won', 2, null), stage('lost', 'lost', 3, null)],
    },
  ];
  // Итог «Договорились — записать» без обязательных полей шторки; «Целевой» требует поле «ниша»
  const outcomes = sp.calling.outcomes as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  outcomes.push({
    key: 'niche_asked',
    kind: 'callback',
    label: t('Перезвонить (ниша)'),
    color: '#336699',
    order: 8,
    reasonGroup: null,
    requires: { lpr: false, reason: false, callbackAt: true, contact: false, fields: ['niche'], agreement: false },
    importAliases: [],
  });
  outcomes.push({
    key: 'old_outcome',
    kind: 'no_answer',
    label: t('Архивный'),
    color: '#336699',
    order: 9,
    reasonGroup: null,
    requires: { lpr: false, reason: false, callbackAt: false, contact: false, fields: [], agreement: false },
    importAliases: [],
    archived: true,
  });
  return c;
}

export async function openCallsWorld(): Promise<TestDb> {
  const db = await openWorld();
  resetConfigCache();
  await writeConfig({ docs: callsConfig(), source: 'cli', authorId: null, project: true, note: 'обзвон: мир тестов' });
  return db;
}

export async function closeCallsWorld(db: TestDb): Promise<void> {
  resetConfigCache();
  await closeWorld(db);
}

/** Зависимости обзвона: настройки из БД, запись с настоящим портом карточки, часы теста. */
export function callsDeps(clock: TestClock): CallsDeps {
  const booking = makeDeps(clock, createCardBookingPort(loadCallingContext), testSettings());
  return { context: loadCallingContext, booking: () => booking, now: () => clock.now };
}

export interface CardSeed {
  state?: string;
  owner?: string | null;
  acting?: string | null;
  /** Последний день замещения; по умолчанию при заданном временном — ACTING_UNTIL (охват ограничен сроком, D-303). */
  actingUntilDay?: string;
  attempts?: number;
  nextCallAt?: number | null;
  lastOutcomeAt?: number | null;
  holdReason?: string;
  version?: number;
}

/** Срок замещения в сценариях по умолчанию: позже любых часов тестов мира (сегодня — 2026-10-28). */
export const ACTING_UNTIL = '2026-11-30';

/** Привести карточку к нужному состоянию (прямой UPDATE: подготовка сценария, не продуктовый путь). */
export async function setCard(sql: Sql, id: string, s: CardSeed): Promise<void> {
  if (s.state !== undefined) await sql`UPDATE cards SET state = ${s.state} WHERE id = ${id}`;
  if (s.owner !== undefined) await sql`UPDATE cards SET owner_user_id = ${s.owner} WHERE id = ${id}`;
  if (s.acting !== undefined) {
    // Как ядро события `absence`: временный всегда со сроком, без временного — пустой срок
    const until = s.acting === null ? '' : (s.actingUntilDay ?? ACTING_UNTIL);
    await sql`UPDATE cards SET acting_user_id = ${s.acting}, acting_until_day = ${until} WHERE id = ${id}`;
  }
  if (s.attempts !== undefined) await sql`UPDATE cards SET attempts = ${s.attempts} WHERE id = ${id}`;
  if (s.nextCallAt !== undefined) await sql`UPDATE cards SET next_call_at = ${s.nextCallAt} WHERE id = ${id}`;
  if (s.lastOutcomeAt !== undefined) await sql`UPDATE cards SET last_outcome_at = ${s.lastOutcomeAt} WHERE id = ${id}`;
  if (s.holdReason !== undefined) await sql`UPDATE cards SET hold_reason = ${s.holdReason} WHERE id = ${id}`;
  if (s.version !== undefined) await sql`UPDATE cards SET version = ${s.version} WHERE id = ${id}`;
}

export interface CardRow {
  state: string;
  attempts: number;
  nextCallAt: number | null;
  version: number;
  ownerUserId: string | null;
  lastOutcomeAt: number | null;
  lastOutcomeCode: string;
  closeReasonCode: string;
  callsTotal: number;
  isTarget: string;
}

export async function cardOf(sql: Sql, id: string): Promise<CardRow> {
  const rows = await sql<CardRow>`SELECT state, attempts, next_call_at, version, owner_user_id, last_outcome_at, last_outcome_code,
                                         close_reason_code, calls_total, is_target FROM cards WHERE id = ${id}`;
  if (!rows[0]) throw new Error(`нет карточки ${id}`);
  return rows[0];
}

/** Тело итога с умолчаниями «Не берёт». */
export function outcomeReq(over: Partial<OutcomeRequest> & Pick<OutcomeRequest, 'cardId'>): OutcomeRequest {
  return {
    opId: uuid(),
    outcomeKey: 'no_answer',
    via: 'ui',
    occurredAt: SEED_NOW - MIN,
    tappedAt: null,
    phoneId: null,
    reasonCode: '',
    note: '',
    lpr: '',
    lprInfo: null,
    callbackAt: null,
    markTarget: false,
    alsoDncPhoneIds: [],
    fields: {},
    durationSec: null,
    agreement: null,
    ...over,
  };
}
