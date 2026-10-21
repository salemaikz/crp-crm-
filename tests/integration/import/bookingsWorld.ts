// Мир интеграционных тестов профиля «Записи» (D-324): настоящий пресет ЦРП (слои base → kz → consulting-sales →
// накладка клиента) с профилем bookings_table и слотом таблицы операторов, РОП и операторы, мероприятия, таблица
// клиентов и таблица записей из синтетического генератора. Только синтетика (+7 709 …, выдуманные компании).
import { join } from 'node:path';
import { imports, names } from '@crm/core';
import type { Json } from '@crm/core/config';
import { assembleLayers } from '../../../packages/core/src/config';
import { generateSyntheticBookings, type SyntheticBookings } from '../../../packages/core/src/import/syntheticBookings';
import { overrideAccessForTests, signInForTests } from '../../../src/server/access/testing';
import { buildViewer } from '../../../src/server/access/viewer';
import type { Viewer } from '../../../src/server/access';
import { importApi, importService, type ImportActor } from '../../../src/server/domain/import';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { loadLayers } from '../../../src/server/platform/config/preset-files';
import { writeConfig } from '../../../src/server/platform/config/write';
import { newId, type DbHandle } from '../../../src/server/platform/db';

const ROOT = join(import.meta.dirname, '..', '..', '..');
export const T0 = Date.UTC(2026, 9, 21, 9, 0, 0); // среда 2026-10-21 09:00 UTC
export const SNAPSHOT = '2026-10-20';
export const CLIENTS_PROFILE = 'operator_tables';
export const BOOKINGS_PROFILE = 'bookings_table';
export const SLOT = 'Синий';

/** Дни мероприятий мира: все в будущем относительно T0, прошедший — до него. */
export const DAYS = { ok: '2026-11-05', other: '2026-11-06', cancelled: '2026-11-07', none: '2026-11-08', past: '2026-10-01', full: '2026-11-09', twoEvents: '2026-11-10' };
/** Подписи видов в ячейке — из карты пресета: групповой, индивидуальный, неизвестный. */
export const LABELS = { group: 'БР', individual: 'БК', unknown: 'Загадка' };

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- документ настроек правится по путям

/** Настройки установки: собранный пресет ЦРП + слот операторской таблицы; `mutate` правит документы до записи. */
export async function installBookingsConfig(mutate?: (docs: { global: Doc; spaces: Doc }) => void): Promise<void> {
  const layers = await loadLayers(['base', 'kz', 'consulting-sales', join(ROOT, 'presets', 'clients', 'crp')], join(ROOT, 'presets'));
  const set = assembleLayers(
    layers.map((l) => l.layer),
    { productVersion: '0.1.0' },
  );
  const docs = { global: structuredClone(set.global) as Doc, spaces: structuredClone(set.spaces) as Doc };
  const tables = (docs.spaces.sales.import.profiles as Doc[]).find((p) => p.key === CLIENTS_PROFILE);
  if (!tables) throw new Error('в пресете нет профиля таблиц операторов');
  tables.ownerSlots = [{ label: SLOT, ranges: [[3, 2000]] }];
  mutate?.(docs);
  resetConfigCache();
  await writeConfig({ docs: { global: docs.global as Json, spaces: docs.spaces as Record<string, Json> }, source: 'cli', authorId: null, project: true, note: 'import bookings test' });
}

export async function spaceIdOf(db: DbHandle, key = 'sales'): Promise<string> {
  const [r] = await db.sql<{ id: string }>`SELECT id FROM spaces WHERE key = ${key}`;
  if (!r) throw new Error(`нет пространства ${key}`);
  return r.id;
}

let phoneSeq = 0;
export async function mkUser(db: DbHandle, spaceId: string, role: string, name: string, status: 'active' | 'disabled' = 'active'): Promise<string> {
  const id = newId();
  phoneSeq++;
  await db.sql`INSERT INTO users (id, phone_digits, name, status, created_at) VALUES (${id}, ${`7709333${String(2000 + phoneSeq)}`}, ${name}, 'active', ${T0})`;
  await db.sql`
    INSERT INTO memberships (user_id, space_id, role_key, in_distribution, paused_on, status, created_at, updated_at)
    VALUES (${id}, ${spaceId}, ${role}, ${role === 'operator'}, '', ${status}, ${T0}, ${T0})`;
  return id;
}

/** Мероприятие группового вида; startsAt — по дате и времени в UTC (достаточно для сравнения с «сейчас»). */
export async function mkEvent(db: DbHandle, spaceId: string, over: { date: string; time?: string; capacity?: number; status?: 'scheduled' | 'cancelled'; type?: string }): Promise<string> {
  const id = newId();
  const time = over.time ?? '15:00';
  await db.sql`
    INSERT INTO events (id, space_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, created_at, updated_at)
    VALUES (${id}, ${spaceId}, ${over.type ?? 'br'}, ${over.date}, ${time}, ${Date.parse(`${over.date}T${time}:00Z`)}, 180, '', 'offline', ${over.capacity ?? 30}, ${over.status ?? 'scheduled'}, ${T0}, ${T0})`;
  return id;
}

export interface MkClient {
  name: string;
  phone: string;
  state?: string;
  ownerUserId?: string | null;
  holdReason?: string;
  touchedInCrm?: boolean;
  orgId?: string;
  iinHmac?: string;
  /** Нет карточки в пространстве (клиент «чужого» пространства). */
  noCard?: boolean;
  spaceId?: string;
}

/** Клиент с карточкой напрямую в БД: быстро и точно по состоянию (для сценариев, где импорт клиентов не нужен). */
export async function mkClient(db: DbHandle, spaceId: string, c: MkClient): Promise<{ clientId: string; cardId: string }> {
  const clientId = newId();
  const cardId = newId();
  const norm = names.normalizeCompanyName(c.name);
  await db.sql`
    INSERT INTO clients (id, kind, name, name_norm, search_norm, org_id, iin_hmac, source_kind, created_at, updated_at)
    VALUES (${clientId}, 'company', ${c.name}, ${norm}, ${norm}, ${c.orgId ?? ''}, ${c.iinHmac ?? null}, 'import', ${T0}, ${T0})`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, is_working, created_at) VALUES (${newId()}, ${clientId}, ${c.phone.replace(/\D/g, '')}, 'mobile', TRUE, TRUE, ${T0})`;
  if (!c.noCard) {
    const state = c.state ?? 'callback';
    const owner = c.ownerUserId === undefined ? null : c.ownerUserId;
    await db.sql`
      INSERT INTO cards (id, space_id, client_id, owner_user_id, state, hold_reason, assigned_at, touched_in_crm, created_at, updated_at)
      VALUES (${cardId}, ${c.spaceId ?? spaceId}, ${clientId}, ${owner}, ${state}, ${c.holdReason ?? ''}, ${owner ? T0 : null}, ${c.touchedInCrm ?? false}, ${T0}, ${T0})`;
  }
  return { clientId, cardId };
}

export interface Staff {
  rop: string;
  op1: string;
  op2: string;
  director: string;
}

export interface BookingsWorld {
  spaceId: string;
  staff: Staff;
  /** Мероприятия по ключу дня (`ok`, `other`, `cancelled`, `full`, `twoEvents:12:00`, …). */
  events: Record<string, string>;
}

/** Мир без таблиц: настройки, сотрудники, мероприятия; доступ подменён на «лицензия действует, время T0». */
export async function makeBookingsWorld(db: DbHandle, over: { fullCapacity?: number } = {}): Promise<BookingsWorld> {
  process.env.FEATURE_IMPORT = '1';
  process.env.FEATURE_IMPORT_BOOKINGS = '1';
  await installBookingsConfig();
  overrideAccessForTests({ license: async () => 'valid', now: () => T0 });
  const spaceId = await spaceIdOf(db);
  const staff: Staff = {
    rop: await mkUser(db, spaceId, 'rop', 'Руководитель Синтетик'),
    op1: await mkUser(db, spaceId, 'operator', 'Оператор Первый'),
    op2: await mkUser(db, spaceId, 'operator', 'Оператор Второй'),
    director: await mkUser(db, spaceId, 'director', 'Директор Синтетик'),
  };
  const events: Record<string, string> = {
    ok: await mkEvent(db, spaceId, { date: DAYS.ok }),
    other: await mkEvent(db, spaceId, { date: DAYS.other }),
    cancelled: await mkEvent(db, spaceId, { date: DAYS.cancelled, status: 'cancelled' }),
    full: await mkEvent(db, spaceId, { date: DAYS.full, capacity: over.fullCapacity ?? 3 }),
    'twoEvents:12:00': await mkEvent(db, spaceId, { date: DAYS.twoEvents, time: '12:00' }),
    'twoEvents:18:00': await mkEvent(db, spaceId, { date: DAYS.twoEvents, time: '18:00' }),
  };
  return { spaceId, staff, events };
}

/** Viewer сотрудника, собранный из БД, как на запросе. */
export async function viewerOf(userId: string): Promise<Viewer> {
  signInForTests(userId);
  return buildViewer();
}

/** Актор импорта с полным Viewer: профиль «Записи» проверяет охваты booking.create и card.assign. */
export async function actorOf(w: BookingsWorld, userId: string = w.staff.rop): Promise<ImportActor> {
  const viewer = await viewerOf(userId);
  return { userId, spaceId: w.spaceId, viewer };
}

/** Таблица → CSV для загрузки (разделитель «;», как у Excel). */
export const csvOf = (grid: readonly (readonly string[])[]): Buffer => Buffer.from(imports.toCsv(grid.map((r) => [...r]), ';'), 'utf-8');

export function generate(fullCapacity = 3): SyntheticBookings {
  return generateSyntheticBookings({ labels: LABELS, days: DAYS, fullCapacity, secondTime: '18:00' });
}

/** Таблица клиентов (операторская) → предпросмотр → применение: карточки «Подтвержден» встают в «Перезвон» с задачей. */
export async function loadClientsTable(w: BookingsWorld, grid: readonly (readonly string[])[], when = T0): Promise<void> {
  const actor = await actorOf(w);
  const up = await importService.upload(actor, { profileKey: CLIENTS_PROFILE, snapshotDay: SNAPSHOT, fileName: 'клиенты.csv', body: csvOf(grid) }, when);
  const ownerMap = { [SLOT]: w.staff.op1 };
  const s = await importService.preview(actor, up.importId, { ownerMap }, when + 1000);
  if (s.blockers.length > 0) throw new Error(`таблица клиентов: блокеры ${s.blockers.join(',')}`);
  await importService.apply(actor, up.importId, { fingerprint: s.fingerprint, ownerMap }, when + 2000);
}

export const upload = async (actor: ImportActor, grid: readonly (readonly string[])[], over: { fileName?: string; profileKey?: string; now?: number } = {}) =>
  importApi.upload(actor, { profileKey: over.profileKey ?? BOOKINGS_PROFILE, snapshotDay: SNAPSHOT, fileName: over.fileName ?? 'записи.csv', body: csvOf(grid) }, over.now ?? T0 + 3000);

export type Counts = Record<string, number>;

/** Снимок бизнес-таблиц записи: повтор той же загрузки обязан его не менять. */
export async function snapshot(db: DbHandle): Promise<Counts> {
  const [r] = await db.sql<Counts>`
    SELECT (SELECT count(*)::int FROM bookings) AS bookings, (SELECT count(*)::int FROM booking_history) AS history,
           (SELECT count(*)::int FROM calls) AS calls, (SELECT count(*)::int FROM deals) AS deals,
           (SELECT count(*)::int FROM tasks) AS tasks, (SELECT count(*)::int FROM client_events) AS events,
           (SELECT count(*)::int FROM assign_log) AS assigns, (SELECT count(*)::int FROM clients) AS clients,
           (SELECT count(*)::int FROM client_phones) AS phones, (SELECT count(*)::int FROM cards) AS cards,
           (SELECT coalesce(sum(version),0)::int FROM cards) AS versions, (SELECT coalesce(sum(version),0)::int FROM bookings) AS bversions`;
  return r as Counts;
}
