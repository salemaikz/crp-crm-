// Общая подготовка интеграционных тестов записи: мир изоляции (операторы A и B, РОП, дежурный, директор),
// карточки в «Договорились», настройки записи, часы, сделки и порт карточки, который зовёт настоящий
// calling.applyOutcome и записывает события (без записи в БД): проверяется вход порта, а не эффекты C5.
import { booking, calling, time } from '../../../packages/core/src';
import type { BookingCardEvent, BookingDeps, BookingSettings, CardPort, LockedCard } from '../../../src/server/domain/booking/types';
import { createDealLink } from '../../../src/server/domain/deals/effects';
import type { PipelineInfo } from '../../../src/server/domain/deals/pipelines';
import type { Sql } from '../../../src/server/platform/db';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SEED_TZ, SPACE } from '../../isolation/harness/seed';
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
