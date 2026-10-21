// Общая подготовка интеграционных тестов записи: мир изоляции (операторы A и B, РОП, дежурный, директор),
// карточки в «Договорились», настройки записи, часы, сделки и порт карточки, который зовёт настоящий
// calling.applyOutcome и записывает события (без записи в БД): проверяется вход порта, а не эффекты C5.
import { booking, calling, time } from '../../../packages/core/src';
import type { BookingCardEvent, BookingCatalog, BookingDeps, BookingSettings, CardPort, LockedCard } from '../../../src/server/domain/booking/types';
import { createDealLink } from '../../../src/server/domain/deals/effects';
import type { PipelineInfo } from '../../../src/server/domain/deals/pipelines';
import type { Sql } from '../../../src/server/platform/db';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SEED_TZ, SPACE, U } from '../../isolation/harness/seed';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { worldConfig } from '../clients/world';
import { closeWorld, openWorld } from '../access/world';

export { SEED_NOW, SEED_TZ, SPACE };
export { viewerOf, actAs, enterSeedWorld } from '../../isolation/harness/actors';

export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;

export const CALENDAR_SETTINGS: time.CalendarSettings = {
  timezone: SEED_TZ,
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
};

export const PIPELINES: PipelineInfo[] = [
  {
    key: 'sales',
    createDealOn: 'agreed',
    stages: [
      { key: 'booked', kind: 'open', order: 10, auto: 'on_agreed' },
      { key: 'attended', kind: 'open', order: 20, auto: 'on_attended' },
      { key: 'offer', kind: 'open', order: 30, auto: null },
      { key: 'lost', kind: 'lost', order: 50, auto: null },
    ],
  },
];

/** Каталог записи ЦРП: БР (групповой) и БК (индивидуальный, 45 мин), 6 направлений, пн–пт 09:00–18:00, шаг 45. */
export const CRP_CATALOG: BookingCatalog = {
  eventTypes: [
    { key: 'br', behavior: 'group', label: { ru: 'Бизнес-разбор' }, short: { ru: 'БР' }, durationMin: 180, directions: [] },
    { key: 'bk', behavior: 'individual', label: { ru: 'Бизнес-консультация' }, short: { ru: 'БК' }, durationMin: 45, directions: [] },
  ],
  directions: [
    { key: 'program', label: { ru: 'Программа' } },
    { key: 'consulting', label: { ru: 'Консалтинг' } },
    { key: 'marketing', label: { ru: 'Маркетинг' } },
    { key: 'automation', label: { ru: 'Автоматизация' } },
    { key: 'training', label: { ru: 'Обучение' } },
    { key: 'other', label: { ru: 'Другое' } },
  ],
  consult: { slotMinutes: 45, hours: { workdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, stripDays: 7 },
};

export function testSettings(over: Partial<BookingSettings> = {}): BookingSettings {
  return {
    spaceId: SPACE,
    timeZone: SEED_TZ,
    calendar: time.createWorkCalendar(CALENDAR_SETTINGS),
    groupTypes: [{ key: 'br', capacity: 30, durationMin: 180 }],
    horizonDays: 28,
    groupOptions: 3,
    seedSeries: [{ key: 'seed_thu', eventTypeKey: 'br', weekday: 4, startTime: '15:00', durationMin: 180, location: 'Зал 1', format: 'offline', capacity: 30 }],
    deals: { pipelineKey: 'sales', onAgreedStageKey: 'booked', onAttendedStageKey: 'attended' },
    operatorErrorWindowMin: 10,
    catalog: CRP_CATALOG,
    ...over,
  };
}

const CALLING_SETTINGS: calling.CallingSettings = {
  outcomes: [],
  lprRequiredOnContact: false,
  lprNoRequiresInfo: false,
  callbackPastToleranceMin: 5,
  offlineWindowHours: 24,
  retry: { steps: ['+1h'], maxAttempts: 3 },
  returnDays: { not_interested: 30, deal_lost_soft: 30 },
  skipLimit: 5,
  capIncludes: [],
  noShowCallbackAt: 'nextWorkday@10:00',
  nextStepTaskAt: 'nextWorkday@10:00',
  autoNoShowWorkdays: 2,
  inboundReplyMinutes: 30,
};

export interface PortCall {
  event: BookingCardEvent;
  result: calling.TransitionResult;
  /** Состояние карточки в момент вызова. */
  state: calling.CardState;
}

export interface FakePort extends CardPort {
  calls: PortCall[];
  reset(): void;
}

export function fakeCardPort(): FakePort {
  const calls: PortCall[] = [];
  const calendar = time.createWorkCalendar(CALENDAR_SETTINGS);
  return {
    calls,
    reset: () => void (calls.length = 0),
    async applyBookingEvent(tx: Sql, actor, card: LockedCard, event, now) {
      const rows = await tx<Omit<calling.CardSnapshot, 'phones'>>`SELECT * FROM cards WHERE id = ${card.id}`;
      const row = rows[0];
      if (!row) throw new Error('fakeCardPort: нет карточки');
      const snapshot: calling.CardSnapshot = { ...row, phones: [] };
      const result = calling.applyOutcome({
        card: snapshot,
        event,
        actor: { userId: actor.kind === 'user' ? actor.userId : null, kind: actor.kind, scope: 'space' },
        now,
        settings: CALLING_SETTINGS,
        calendar,
      });
      calls.push({ event, result, state: snapshot.state });
      return result;
    },
  };
}

export interface TestClock {
  now: number;
}

export function makeDeps(clock: TestClock, cards: CardPort, settings: BookingSettings = testSettings()): BookingDeps {
  return {
    cards,
    deals: createDealLink(async () => PIPELINES),
    settings: async () => settings,
    now: () => clock.now,
  };
}

/** Мир: временная схема + синтетика изоляции; все карточки A и B — в «Договорились». */
export async function openBookingWorld(): Promise<TestDb> {
  const db = await openWorld();
  await db.sql`UPDATE cards SET state = 'agreed'`;
  return db;
}
export { closeWorld };

/**
 * Мир дежурства и гостей без записи (B4): мир записи + настройки установки (роли ЦРП, правила номеров, источник
 * `walk_in`, лимит проверок номера 20). Карточки A и B — «Договорились».
 */
export async function openDutyWorld(): Promise<TestDb> {
  const db = await openBookingWorld();
  resetConfigCache();
  const docs = worldConfig();
  (docs.global['sources'] as unknown[]).push({
    key: 'walk_in',
    label: { ru: 'Пришёл без записи' },
    kind: 'walk_in',
    allowPersonNames: true,
    detailedReport: false,
    rejectRules: [],
    holdRules: [],
  });
  (docs.global['security'] as Record<string, unknown>)['phoneProbesPerDay'] = 20;
  await writeConfig({ docs, source: 'cli', authorId: null, project: true, note: 'запись: мир дежурства' });
  return db;
}

export async function closeDutyWorld(db: TestDb): Promise<void> {
  resetConfigCache();
  await closeWorld(db);
}

export async function setCardState(sql: Sql, cardId: string, state: calling.CardState): Promise<void> {
  await sql`UPDATE cards SET state = ${state} WHERE id = ${cardId}`;
}

export interface EventSeed {
  id: string;
  date: string;
  time: string;
  capacity?: number;
  type?: string;
  durationMin?: number;
  status?: 'scheduled' | 'cancelled';
  seriesId?: string | null;
  occurrenceKey?: string | null;
  touched?: boolean;
  location?: string;
  format?: string;
}

export async function seedEvent(sql: Sql, e: EventSeed): Promise<string> {
  const startsAt = booking.localToEpoch(SEED_TZ, e.date, e.time);
  await sql`
    INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format,
                        capacity, status, occurrence_key, touched, created_at, updated_at)
    VALUES (${e.id}, ${SPACE}, ${e.seriesId ?? null}, ${e.type ?? 'br'}, ${e.date}, ${e.time}, ${startsAt}, ${e.durationMin ?? 180},
            ${e.location ?? ''}, ${e.format ?? 'offline'}, ${e.capacity ?? 30}, ${e.status ?? 'scheduled'}, ${e.occurrenceKey ?? null},
            ${e.touched ?? false}, ${SEED_NOW - DAY}, ${SEED_NOW - DAY})`;
  return e.id;
}

/** Записи напрямую в БД (в обход сервиса): заполнить мероприятие чужими гостями. */
export async function seedBookings(
  sql: Sql,
  eventId: string,
  clients: ReadonlyArray<{ client: string; card: string }>,
  over: { status?: booking.BookingStatus; bookedBy?: string | null } = {},
): Promise<string[]> {
  const ev = (await sql<{ eventDate: string; startTime: string; startsAt: number; durationMin: number; eventTypeKey: string }>`SELECT * FROM events WHERE id = ${eventId}`)[0];
  if (!ev) throw new Error(`нет мероприятия ${eventId}`);
  const ids: string[] = [];
  for (const c of clients) {
    const id = `bk-seed-${eventId}-${c.client}`;
    ids.push(id);
    await sql`
      INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, booking_date, start_time, starts_at, duration_min,
                            status, booked_by_user_id, responsible_user_id, version, created_at, updated_at)
      VALUES (${id}, ${SPACE}, 'group', ${ev.eventTypeKey}, ${eventId}, ${c.client}, ${c.card}, ${ev.eventDate}, ${ev.startTime}, ${ev.startsAt},
              ${ev.durationMin}, ${over.status ?? 'registered'}, ${over.bookedBy ?? null}, ${over.bookedBy ?? null}, 0, ${SEED_NOW - DAY}, ${SEED_NOW - DAY})`;
  }
  return ids;
}

/** Клиенты оператора: [{client:'cl-a-5', card:'cd-a-5'}, …] для номеров from..to. */
export function clientsOf(who: 'a' | 'b', from: number, to: number): Array<{ client: string; card: string }> {
  const out: Array<{ client: string; card: string }> = [];
  for (let i = from; i <= to; i++) out.push({ client: `cl-${who}-${i}`, card: `cd-${who}-${i}` });
  return out;
}

export const uuid = (): string => globalThis.crypto.randomUUID();

// ---------------------------------------------------------------------------
// Консультации (B5b/B5c): флаг BK_WIZARD, настройки автоназначения, консультанты и график напрямую в БД
// ---------------------------------------------------------------------------

export interface GreyConfig {
  mode?: 'assign' | 'suggest';
  first?: string;
  last?: string;
  stepMin?: number;
}

/** Записать ревизию настроек мира с заданным `booking.grey` (режим и сетка прогонов автоназначения). */
export async function setGreyConfig(g: GreyConfig): Promise<void> {
  resetConfigCache();
  const docs = worldConfig();
  const grey = ((docs.spaces.sales as Record<string, unknown>).booking as Record<string, unknown>).grey as Record<string, unknown>;
  const schedule = grey.schedule as Record<string, unknown>;
  if (g.mode) grey.mode = g.mode;
  if (g.first) schedule.first = g.first;
  if (g.last) schedule.last = g.last;
  if (g.stepMin) schedule.stepMin = g.stepMin;
  await writeConfig({ docs, source: 'cli', authorId: null, project: true, note: 'запись: автоназначение' });
}

/**
 * Мир консультаций: флаг BK_WIZARD включён, сидовые консультанты выключены (в пуле только созданные тестом),
 * настройки — с заданным `booking.grey`.
 */
export async function openConsultWorld(grey: GreyConfig = { mode: 'assign' }): Promise<TestDb> {
  process.env['FEATURE_BK_WIZARD'] = '1';
  const db = await openBookingWorld();
  await db.sql`UPDATE resources SET active = FALSE`;
  await setGreyConfig(grey);
  return db;
}

export async function closeConsultWorld(db: TestDb): Promise<void> {
  delete process.env['FEATURE_BK_WIZARD'];
  resetConfigCache();
  await closeWorld(db);
}

export interface ConsultantSeed {
  id: string;
  userId: string;
  directions?: string[];
  slotMin?: number;
  capacity?: number;
  autoAssign?: boolean;
  active?: boolean;
  sort?: number;
}

export async function addConsultant(sql: Sql, c: ConsultantSeed): Promise<string> {
  await sql`
    INSERT INTO resources (id, space_id, user_id, directions, slot_min, capacity, auto_assign, active, sort, created_at, updated_at)
    VALUES (${c.id}, ${SPACE}, ${c.userId}, ${c.directions ?? []}::text[], ${c.slotMin ?? 45}, ${c.capacity ?? 1}, ${c.autoAssign ?? true},
            ${c.active ?? true}, ${c.sort ?? 0}, ${SEED_NOW}, ${SEED_NOW})`;
  return c.id;
}

/** Недельный график: [день недели 1–7, 'HH:MM', 'HH:MM'][]. */
export async function addSchedule(sql: Sql, resourceId: string, windows: ReadonlyArray<readonly [number, string, string]>): Promise<void> {
  for (const [weekday, start, end] of windows) {
    await sql`INSERT INTO resource_schedule (id, resource_id, weekday, start_time, end_time) VALUES (${uuid()}, ${resourceId}, ${weekday}, ${start}, ${end})`;
  }
}

/** Рабочие дни пн–пт с одним окном. */
export const weekdays = (start: string, end: string): Array<[number, string, string]> => [1, 2, 3, 4, 5].map((d) => [d, start, end]);

export async function addException(sql: Sql, resourceId: string, day: string, kind: 'off' | 'custom', windows: ReadonlyArray<{ start: string; end: string }> = []): Promise<void> {
  await sql`
    INSERT INTO resource_exceptions (id, resource_id, day, kind, windows, created_at)
    VALUES (${uuid()}, ${resourceId}, ${day}, ${kind}, ${JSON.stringify(windows)}::jsonb, ${SEED_NOW})`;
}

/** «Серая» заявка напрямую в БД (в обход сервиса): для автоназначения и экранов. */
export async function insertGrey(
  sql: Sql,
  g: { id: string; client: string; card: string; date: string; time: string; direction?: string; durationMin?: number; createdAt?: number; resourceId?: string | null; status?: string },
): Promise<string> {
  await sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time, starts_at, duration_min,
                          direction_key, status, booked_by_user_id, responsible_user_id, version, created_at, updated_at)
    VALUES (${g.id}, ${SPACE}, 'individual', 'bk', ${g.resourceId ?? null}, ${g.client}, ${g.card}, ${g.date}, ${g.time},
            ${booking.localToEpoch(SEED_TZ, g.date, g.time)}, ${g.durationMin ?? 45}, ${g.direction ?? 'marketing'}, ${g.status ?? 'registered'},
            ${U.opA}, ${U.opA}, 0, ${g.createdAt ?? SEED_NOW}, ${g.createdAt ?? SEED_NOW})`;
  return g.id;
}
