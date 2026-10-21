// Мир интеграционных тестов сделок (B6): синтетика изоляции + ревизия настроек с воронкой продаж, услугами
// (одна уходит в отдел маркетинга, одна — без передачи, одна — в отдел без строки в БД), причинами проигрыша,
// сроком даты покупки 36 ч и сроком принятия передачи 1 рабочий день. Флаг PURCHASES включён.
// Порт карточки — настоящий (cards/bookingPort): проверяются и сделка, и карточка, и задачи, и лента.
import type { JsonObject } from '@crm/core/config';
import { cardBookingPort } from '../../../src/server/domain/cards/bookingPort';
import { loadDealsSettings } from '../../../src/server/domain/deals/settings';
import type { DealsDeps, DealsSettings } from '../../../src/server/domain/deals/types';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { Sql } from '../../../src/server/platform/db';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { worldConfig } from '../clients/world';
import { closeWorld, openWorld } from '../access/world';

export { SEED_NOW, SPACE, TEAM_MKT, U, FX } from '../../isolation/harness/seed';
export { viewerOf, actAs } from '../../isolation/harness/actors';

/** Чт 29.10.2026 14:00 по Алматы: срок принятия передачи — пт 30.10 18:00. */
export const THU_14 = Date.UTC(2026, 9, 29, 9, 0);
export const FRI_18 = Date.UTC(2026, 9, 30, 13, 0);
/** 12:00 местного 29.10 — момент покупки «днём». */
export const THU_NOON = Date.UTC(2026, 9, 29, 7, 0);
export const MIN = 60_000;
export const DAY = 86_400_000;

const t = (ru: string): JsonObject => ({ ru });
const NO_REQ = { fields: [], booking: false, attendance: false, nextTask: false, amount: false, serviceType: false, reason: false };
const stage = (key: string, kind: 'open' | 'won' | 'lost', order: number, extra: { auto?: 'on_agreed' | 'on_attended'; requires?: Record<string, unknown> } = {}): JsonObject => ({
  key,
  label: t(`Этап ${key}`),
  kind,
  order,
  requires: { ...NO_REQ, ...(extra.requires ?? {}) },
  staleDays: null,
  auto: extra.auto ?? null,
});

export function dealsWorldConfig(): { global: JsonObject; spaces: Record<string, JsonObject> } {
  const docs = worldConfig();
  const sp = docs.spaces.sales as Record<string, unknown>;
  sp.pipelines = [
    {
      key: 'sales',
      kind: 'sales',
      label: t('Продажи'),
      createDealOn: 'agreed',
      stages: [
        stage('booked', 'open', 10, { auto: 'on_agreed' }),
        stage('attended', 'open', 20, { auto: 'on_attended', requires: { attendance: true } }),
        stage('offer', 'open', 30, { requires: { nextTask: true } }),
        stage('contract', 'open', 35, { requires: { fields: ['budget'] } }),
        stage('paid', 'won', 40, { requires: { amount: true, serviceType: true } }),
        stage('lost', 'lost', 50),
      ],
    },
  ];
  sp.serviceTypes = [
    { key: 'smm', label: t('Услуга с передачей'), routeToTeam: 'marketing' },
    { key: 'master_group', label: t('Услуга без передачи'), routeToTeam: null },
    { key: 'design', label: t('Услуга в отдел без строки'), routeToTeam: 'design' },
  ];
  sp.teams = [
    { key: 'marketing', label: t('Отдел А') },
    { key: 'design', label: t('Отдел Б') },
  ];
  const reasons = sp.reasons as Record<string, unknown>;
  reasons.deal_lost = [
    { key: 'no_time', label: t('Нет времени'), needsText: false, softness: 'soft' },
    { key: 'company_closed', label: t('Компания закрылась'), needsText: false, softness: 'hard' },
    { key: 'other', label: t('Другое'), needsText: true, softness: 'hard' },
  ];
  // Поле сделки для требования этапа «contract»
  sp.fields = [
    {
      key: 'budget',
      object: 'deal',
      type: 'text',
      label: t('Бюджет'),
      options: [],
      access: {},
      required: { always: false, onOutcome: [], onStage: [] },
      searchable: false,
      filterable: false,
      ingest: false,
      pii: 'none',
      showOn: { card: true, kanban: false, list: false },
    },
  ];
  sp.deals = { purchaseFutureLimitHours: 36 };
  sp.handoff = { acceptSlaWorkdays: 1, alarmTo: ['rop'] };
  return docs;
}

export async function openDealsWorld(): Promise<TestDb> {
  process.env['FEATURE_PURCHASES'] = '1';
  const db = await openWorld();
  resetConfigCache();
  await writeConfig({ docs: dealsWorldConfig(), source: 'cli', authorId: null, project: true, note: 'сделки: мир тестов' });
  await db.sql`UPDATE cards SET state = 'agreed'`;
  return db;
}

export async function closeDealsWorld(db: TestDb): Promise<void> {
  delete process.env['FEATURE_PURCHASES'];
  resetConfigCache();
  await closeWorld(db);
}

export interface Clock {
  now: number;
}

/** Зависимости с настоящими портом карточки и настройками; `patch` подменяет срез (например, календарь). */
export function makeDealsDeps(clock: Clock, patch?: (s: DealsSettings) => DealsSettings): DealsDeps {
  return {
    cards: cardBookingPort,
    settings: async (spaceId, now) => {
      const s = await loadDealsSettings(spaceId, now);
      return patch ? patch(s) : s;
    },
    now: () => clock.now,
  };
}

export const uuid = (): string => globalThis.crypto.randomUUID();

/** Открытая сделка карточки на этапе (в обход сервиса). */
export async function seedDeal(sql: Sql, d: { id: string; client: string; card: string; stage?: string; owner?: string | null; status?: 'open' | 'won' | 'lost'; custom?: Record<string, unknown> }): Promise<string> {
  const at = Date.UTC(2026, 9, 20, 6, 0);
  await sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, won_at, lost_at, stage_changed_at, custom, version,
                       created_by, created_at, updated_at)
    VALUES (${d.id}, 'sp-sales', 'sales', ${d.stage ?? 'offer'}, ${d.status ?? 'open'}, ${d.client}, ${d.card}, ${d.owner === undefined ? null : d.owner},
            ${d.status === 'won' ? at : null}, ${d.status === 'lost' ? at : null}, ${at}, ${JSON.stringify(d.custom ?? {})}::jsonb, 0, NULL, ${at}, ${at})`;
  return d.id;
}

export const dealRow = async (sql: Sql, id: string) =>
  (
    await sql<{ id: string; status: string; stageKey: string; amountKzt: number; serviceTypeKey: string; wonAt: number | null; lostReasonCode: string; lostReasonText: string; version: number; requestId: string | null }>`
      SELECT * FROM deals WHERE id = ${id}`
  )[0];

export const cardState = async (sql: Sql, id: string): Promise<string> => (await sql<{ state: string }>`SELECT state FROM cards WHERE id = ${id}`)[0]!.state;
