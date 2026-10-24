// Изоляция обзвона «подтвердить явку» (pv2-round3 §6.1 S2, D-355): оператор B не видит пометок и счётчика карточек оператора A
// и наоборот, фильтр `confirm` охват не расширяет, директор видит пометки и получает 423 на подтверждение записи.
// Окно обзвона включается накладкой настроек (все дни недели, вид синтетики), как на стенде: код времени не подменяется.
// Хуки регистрируются ДО загрузки src/** (как в board.test.ts), поэтому проект грузится динамически.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

register('../runner/hooks.mjs', import.meta.url);
process.env['FEATURE_BK_WIZARD'] ??= '1';
process.env['FEATURE_OP_BOARD'] ??= '1';
process.env['FEATURE_CALLBACK_V2'] ??= '1';

const { createTestDb } = await import('../../../src/server/platform/db/testing');
const { resetAccessForTests } = await import('../../../src/server/access/testing');
const { bookingDeps, overrideBookingDepsForTests } = await import('../../../src/server/domain/booking');
const { getActiveConfig, resetConfigCache } = await import('../../../src/server/platform/config/active');
const { writeConfig } = await import('../../../src/server/platform/config/write');
const { actAs, enterSeedWorld } = await import('../harness/actors');
const { applySeedConfig, SEED_PRESET } = await import('../harness/config');
const { SEED_NOW, SEED_EVENT_TYPE, SPACE, U, seedIsolation } = await import('../harness/seed');
const { allForeignNeedles, markFixtures } = await import('../runner/objects');
const { leakViolations, snapshotViolations } = await import('../runner/checks');
const { snapshotTables } = await import('../runner/snapshot');
const { withRequestScope } = await import('../runner/shims/nextHeaders');
const { ORIGIN } = await import('../runner/invoke');

import type { Reply, Needle } from '../runner/checks';
import type { TestDb } from '../../../src/server/platform/db/testing';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ROUTES = {
  board: 'src/app/api/cards/board/route.ts',
  column: 'src/app/api/cards/board/column/route.ts',
  confirm: 'src/app/api/bookings/[id]/confirm/route.ts',
} as const;
const HOUR = 3_600_000;
const modules = new Map<string, Promise<Record<string, unknown>>>();
const loadModule = (file: string) => {
  let m = modules.get(file);
  if (!m) modules.set(file, (m = import(pathToFileURL(join(ROOT, file)).href) as Promise<Record<string, unknown>>));
  return m;
};

async function api(userId: string | null, file: keyof typeof ROUTES, opts: { method?: 'GET' | 'POST'; query?: string; body?: unknown; params?: Record<string, string> } = {}): Promise<Reply> {
  actAs(userId);
  const method = opts.method ?? 'GET';
  const handler = (await loadModule(ROUTES[file]))[method] as (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
  const headers: Record<string, string> = { host: 'crm.test' };
  if (method !== 'GET') {
    headers['origin'] = ORIGIN;
    headers['content-type'] = 'application/json';
  }
  const req = new Request(`${ORIGIN}/x${opts.query ?? ''}`, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(opts.body ?? {}) } : {}) });
  try {
    const res = await withRequestScope({ headers: req.headers }, () => handler(req, { params: Promise.resolve(opts.params ?? {}) }));
    const hs: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      hs[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: hs, body: await res.text() };
  } catch (e) {
    const digest = (e as { digest?: unknown } | null)?.digest;
    if (typeof digest === 'string') {
      const m = /^NEXT_HTTP_ERROR_FALLBACK;(\d{3})$/.exec(digest);
      if (m) return { status: Number(m[1]), headers: {}, body: '' };
      if (digest === 'NEXT_NOT_FOUND') return { status: 404, headers: {}, body: '' };
    }
    return { status: 500, headers: {}, body: `исключение: ${String((e as { message?: unknown } | null)?.message ?? e).slice(0, 300)}` };
  } finally {
    actAs(null);
  }
}

const json = <T>(r: Reply): T => JSON.parse(r.body) as T;
type Card = { id: string; confirm?: { mark: string; tries: number; confirmedBy?: string } };
type Board = { columns: Array<{ key: string; cards: Card[]; next: string | null }>; confirm?: { summary: { todo: number; tried: number; confirmed: number }; events: unknown[] } };
const cardsOf = (b: Board): Card[] => b.columns.flatMap((c) => c.cards);

let db: TestDb;
let foreign: Needle[] = [];

/** Карточка «Договорились» с открытой сделкой и записью `registered` на мероприятие сегодня 15:00 (позже «сейчас» прогона). */
async function agreed(o: { n: string; owner: string; phone: string }): Promise<{ card: string; booking: string }> {
  const t = SEED_NOW - HOUR;
  const client = `cf-cl-${o.n}`;
  const card = `cf-cd-${o.n}`;
  const name = `ТОО Синтетика Явка ${o.n}`;
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
               VALUES (${client}, 'company', ${name}, ${name.toLowerCase()}, ${`${name.toLowerCase()} ${o.phone}`}, 'import', ${t}, ${t})`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${`ph-${client}`}, ${client}, ${o.phone}, 'mobile', TRUE, ${t})`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
               VALUES (${card}, ${SPACE}, ${client}, ${o.owner}, 'agreed', ${t}, ${t}, ${t})`;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_by, created_at, updated_at)
               VALUES (${`cf-dl-${o.n}`}, ${SPACE}, 'sales', 'booked', 'open', ${client}, ${card}, ${o.owner}, ${t}, ${o.owner}, ${t}, ${t})`;
  const booking = `cf-bk-${o.n}`;
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min,
                                     booked_by_user_id, responsible_user_id, created_at, updated_at)
               VALUES (${booking}, ${SPACE}, 'group', ${SEED_EVENT_TYPE}, 'cf-ev', ${client}, ${card}, ${`cf-dl-${o.n}`}, '2026-10-28', '15:00', ${Date.UTC(2026, 9, 28, 10, 0)}, 180,
                      ${o.owner}, ${o.owner}, ${t}, ${t})`;
  return { card, booking };
}

async function noAnswer(card: string, client: string, user: string, at: number): Promise<void> {
  await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, outcome_code, outcome_kind, applied, fact_reason, occurred_at, received_at, config_rev)
               VALUES (${`cf-call-${card}`}, ${SPACE}, ${card}, ${client}, ${user}, 'ui', 'no_answer', 'no_answer', 'fact_only', 'stale', ${at}, ${at}, 1)`;
}

let a1: { card: string; booking: string };
let b1: { card: string; booking: string };

before(async () => {
  db = await createTestDb();
  await seedIsolation(db.sql);
  await applySeedConfig();
  // Накладка: обзвон во все дни недели для вида синтетики; причина отказа — любая живая ручная причина перезвона
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === SPACE)!;
  const doc = space.doc as unknown as { booking: Record<string, unknown>; reasons: { callback?: Array<{ key: string; archived?: boolean; manual?: boolean }> } & Record<string, unknown> };
  // В базовом пресете причин перезвона нет: накладка добавляет одну (в пресете клиента берётся его живая ручная причина)
  const live = doc.reasons.callback?.find((r) => r.archived !== true && r.manual !== false);
  const reason = live?.key ?? 'cf_wont_come';
  const reasons = live ? doc.reasons : { ...doc.reasons, callback: [...(doc.reasons.callback ?? []), { key: reason, label: { ru: 'Не придёт' }, needsText: false, softness: 'soft' }] };
  const key = Object.entries(cfg.spaces).find(([, s]) => s.spaceId === SPACE)![0];
  await writeConfig({
    docs: { spaces: { [key]: { ...(doc as object), reasons, booking: { ...doc.booking, confirmCall: { eventTypes: [SEED_EVENT_TYPE], weekdays: [1, 2, 3, 4, 5, 6, 7], declineReason: reason } } } as never } },
    source: 'cli',
    authorId: null,
    note: 'изоляция обзвона: накладка confirmCall',
  });
  resetConfigCache();
  await markFixtures(db.sql);
  await db.sql`INSERT INTO events (id, space_id, event_type_key, event_date, start_time, starts_at, duration_min, capacity, created_at, updated_at)
               VALUES ('cf-ev', ${SPACE}, ${SEED_EVENT_TYPE}, '2026-10-28', '15:00', ${Date.UTC(2026, 9, 28, 10, 0)}, 180, 30, ${SEED_NOW}, ${SEED_NOW})`;
  enterSeedWorld();
  overrideBookingDepsForTests({ ...bookingDeps(), now: () => SEED_NOW });
  a1 = await agreed({ n: 'a1', owner: U.opA, phone: '77092900001' });
  b1 = await agreed({ n: 'b1', owner: U.opB, phone: '77092900002' });
  await noAnswer(b1.card, 'cf-cl-b1', U.opB, SEED_NOW - HOUR / 2);
  foreign = await allForeignNeedles(db.sql);
});

after(async () => {
  resetAccessForTests();
  overrideBookingDepsForTests(null);
  await db?.close();
});

describe(`обзвон подтверждения явки: изоляция (${SEED_PRESET})`, () => {
  test('оператор A: пометки только своих карточек, счётчик не считает чужие недозвоны и записи', async () => {
    const r = await api(U.opA, 'board');
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.deepEqual(leakViolations('доска обзвона', r, foreign), []);
    const b = json<Board>(r);
    assert.deepEqual(b.confirm?.summary, { todo: 1, tried: 0, confirmed: 0 }, 'в счётчике A только его карточка; недозвон B в него не попадает');
    const marked = cardsOf(b).filter((c) => c.confirm);
    assert.deepEqual(marked.map((c) => c.id), [a1.card]);
    assert.equal(marked[0]!.confirm?.mark, 'todo');
    assert.ok(!r.body.includes(b1.card), 'id чужой карточки в ответе не встречается');
  });

  test('оператор B видит своё: tried и счётчик; карточка A ему не видна (контроль: проверка не пустая)', async () => {
    const r = await api(U.opB, 'board');
    const b = json<Board>(r);
    assert.deepEqual(b.confirm?.summary, { todo: 0, tried: 1, confirmed: 0 });
    assert.deepEqual(cardsOf(b).filter((c) => c.confirm).map((c) => [c.id, c.confirm?.mark, c.confirm?.tries]), [[b1.card, 'tried', 1]]);
    assert.ok(!r.body.includes(a1.card));
  });

  test('фильтр confirm охват не расширяет: у A только его карточка, «Ещё» и owner чужого — без данных B', async () => {
    const f = await api(U.opA, 'board', { query: '?filter=confirm' });
    assert.equal(f.status, 200, f.body.slice(0, 200));
    assert.deepEqual(cardsOf(json<Board>(f)).map((c) => c.id), [a1.card]);
    assert.deepEqual(leakViolations('фильтр confirm', f, foreign), []);
    const owner = await api(U.opA, 'board', { query: `?filter=confirm&owner=${U.opB}` });
    assert.equal(owner.status, 400, owner.body.slice(0, 200));
    const col = json<Board>(f).columns.find((c) => c.cards.length > 0)!;
    const more = await api(U.opA, 'column', { query: `?column=${encodeURIComponent(col.key)}&filter=confirm` });
    assert.equal(more.status, 200, more.body.slice(0, 200));
    assert.deepEqual(leakViolations('«Ещё» confirm', more, foreign), []);
  });

  test('РОП (охват пространства) видит обе пометки и общий счётчик, имя подтвердившего только у него (контроль)', async () => {
    const b = json<Board>(await api(U.rop, 'board'));
    assert.deepEqual(b.confirm?.summary, { todo: 1, tried: 1, confirmed: 0 });
    assert.deepEqual(cardsOf(b).filter((c) => c.confirm).map((c) => c.id).sort(), [a1.card, b1.card].sort());
  });

  test('директор: видит пометки и счётчик пространства, подтверждение записи — 423, таблицы не менялись', async () => {
    const board = json<Board>(await api(U.director, 'board'));
    assert.deepEqual(board.confirm?.summary, { todo: 1, tried: 1, confirmed: 0 });
    const snap = await snapshotTables(db.sql, ['bookings', 'booking_history', 'cards', 'deals', 'calls']);
    const r = await api(U.director, 'confirm', { method: 'POST', params: { id: a1.booking }, body: { opId: crypto.randomUUID(), version: 0, to: 'confirmed' } });
    assert.equal(r.status, 423, r.body.slice(0, 200));
    assert.deepEqual(snapshotViolations('директор подтверждает', snap, await snapshotTables(db.sql, ['bookings', 'booking_history', 'cards', 'deals', 'calls'])), []);
  });

  test('оператор A не подтверждает запись B: 404 тем же телом, что и несуществующая; запись не менялась', async () => {
    const snap = await snapshotTables(db.sql, ['bookings', 'booking_history']);
    const body = { opId: crypto.randomUUID(), version: 0, to: 'confirmed' };
    const f = await api(U.opA, 'confirm', { method: 'POST', params: { id: b1.booking }, body });
    const m = await api(U.opA, 'confirm', { method: 'POST', params: { id: 'zz-no-such-booking' }, body });
    assert.equal(f.status, 404, f.body.slice(0, 200));
    assert.equal(f.body.replaceAll(b1.booking, '<id>'), m.body.replaceAll('zz-no-such-booking', '<id>'));
    assert.deepEqual(snapshotViolations('A подтверждает запись B', snap, await snapshotTables(db.sql, ['bookings', 'booking_history'])), []);
  });
});
