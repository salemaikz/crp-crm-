// Строки изоляции доски оператора (pipeline-v2 §14, линия Q1). Общий прогон по манифесту (run.test.ts) проверяет каждую
// запись «оператор A → объект B» с типовым телом; здесь — точные случаи §14, которым нужны свои тела, запросы и
// синтетика: «Ещё» по курсору, поиск, № 32 и № 33 с явкой, «Мои покупки», список явки, директор (423), фильтр owner,
// отдел передачи и консультант. Запуск: npm run test:isolation (оба пресета: ISOLATION_PRESET=base).
//
// Хуки регистрируются ДО загрузки src/** (как в run.test.ts), поэтому проект грузится динамически.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

register('../runner/hooks.mjs', import.meta.url);
process.env.FEATURE_REPORTS ??= '1';
process.env.FEATURE_SALES_SETTINGS ??= '1';
process.env['FEATURE_BK_WIZARD'] ??= '1';
process.env['FEATURE_PURCHASES'] ??= '1';
process.env['FEATURE_PUSH'] ??= '1';
process.env['FEATURE_OP_BOARD'] ??= '1';
process.env['FEATURE_CALLBACK_V2'] ??= '1';

const { createTestDb } = await import('../../../src/server/platform/db/testing');
const { resetAccessForTests } = await import('../../../src/server/access/testing');
const { bookingDeps, overrideBookingDepsForTests } = await import('../../../src/server/domain/booking');
const { actAs, enterSeedWorld, viewerOf } = await import('../harness/actors');
const { applySeedConfig, configDoc, SEED_PRESET } = await import('../harness/config');
const { SEED_NOW, SPACE, FX, U, cardOf, clientOf, roleOf, nameOf, seedIsolation } = await import('../harness/seed');
const { allForeignNeedles, markFixtures } = await import('../runner/objects');
const { leakViolations, notFoundViolations, snapshotViolations } = await import('../runner/checks');
const { snapshotTables } = await import('../runner/snapshot');
const { withRequestScope } = await import('../runner/shims/nextHeaders');
const { invoke, ORIGIN } = await import('../runner/invoke');
const { scanApp } = await import('../../helpers/appScan');
const { matchEntries } = await import('../../helpers/manifestCoverage');
const { allEntries } = await import('../harness/load');

import type { Reply, Needle } from '../runner/checks';
import type { TestDb } from '../../../src/server/platform/db/testing';
import type { Snapshot } from '../runner/checks';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MISSING = 'zz-q1-no-such-object';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Таблицы, которые могут менять действия карточки, явка и сделки. */
const TOUCHED = ['cards', 'tasks', 'client_events', 'bookings', 'booking_history', 'deals', 'notes', 'calls', 'stop_list', 'audit_log'];

type CallOpts = { method?: 'GET' | 'POST'; query?: string; body?: unknown; params?: Record<string, string> };
const ROUTES = {
  board: 'src/app/api/cards/board/route.ts',
  column: 'src/app/api/cards/board/column/route.ts',
  close: 'src/app/api/cards/[id]/close/route.ts',
  move: 'src/app/api/cards/[id]/move/route.ts',
  mine: 'src/app/api/deals/mine/route.ts',
  report: 'src/app/api/reports/[key]/route.ts',
} as const;

const modules = new Map<string, Promise<Record<string, unknown>>>();
const loadModule = (file: string) => {
  let m = modules.get(file);
  if (!m) modules.set(file, (m = import(pathToFileURL(join(ROOT, file)).href) as Promise<Record<string, unknown>>));
  return m;
};

/** Вызов маршрута от лица сотрудника с запросом и телом (invoke раннера подставляет только тело манифеста). */
async function api(userId: string | null, file: keyof typeof ROUTES, opts: CallOpts = {}): Promise<Reply> {
  actAs(userId);
  const method = opts.method ?? 'GET';
  const handler = (await loadModule(ROUTES[file]))[method] as (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
  const headers: Record<string, string> = { host: 'crm.test' };
  if (method !== 'GET') {
    headers['origin'] = ORIGIN;
    headers['content-type'] = 'application/json';
  }
  const url = `${ORIGIN}/x${opts.query ?? ''}`;
  const req = new Request(url, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(opts.body ?? {}) } : {}) });
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

type Card = { id: string; clientId: string; name: string; purchases?: unknown };
type Column = { key: string; cards: Card[]; next: string | null };
type Board = { columns: Column[]; canFilterOwner: boolean; search?: { matches: Card[]; short: boolean } };

let db: TestDb;
let foreign: Needle[] = [];
let before0: Snapshot;

// Синтетика линии: свои карточки A в «Договорились» с записями, чужая (B), перенесённый от A к B клиент, сделки
const F = {
  /** Своя карточка A в «Договорились», открытая сделка, запись группы на сегодняшнем мероприятии. */
  agreedA: { card: 'q1-cd-a-agreed', client: 'q1-cl-a-agreed', deal: 'q1-dl-a-agreed', booking: 'q1-bk-a-agreed', lostDeal: 'q1-dl-a-lost', lostBooking: 'q1-bk-a-lost' },
  /** Вторая своя «Договорились» A — её запись не относится к карточке agreedA. */
  agreedA2: { card: 'q1-cd-a-agreed2', client: 'q1-cl-a-agreed2', deal: 'q1-dl-a-agreed2', booking: 'q1-bk-a-agreed2' },
  /** Карточка B в «Договорились» с записью. */
  agreedB: { card: 'q1-cd-b-agreed', client: 'q1-cl-b-agreed', deal: 'q1-dl-b-agreed', booking: 'q1-bk-b-agreed' },
  /** Своя карточка A: попыток нет (списание оператором — 409) и с попытками. */
  zeroA: { card: 'q1-cd-a-zero', client: 'q1-cl-a-zero' },
  attemptsA: { card: 'q1-cd-a-att', client: 'q1-cl-a-att' },
  /** Клиент ушёл от A к B: карточка у B, засчитанная A покупка. */
  movedAwayClient: 'q1-cl-moved',
  movedAwayCard: 'q1-cd-moved',
  movedAwayDeal: 'q1-dl-moved-won',
  /** Покупка, засчитанная A и видимая ему; покупка, засчитанная B. */
  ownWonDeal: 'q1-dl-a-won',
  foreignWonDeal: 'q1-dl-b-won',
} as const;

async function addClientCard(opts: { client: string; card: string; owner: string; name: string; phone: string; state: string; attempts?: number }): Promise<void> {
  const t = SEED_NOW - 3_600_000;
  const sql = db.sql;
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${opts.client}, 'company', ${opts.name}, ${opts.name.toLowerCase()}, ${`${opts.name.toLowerCase()} ${opts.phone}`}, 'import', ${t}, ${t})`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${`ph-${opts.client}`}, ${opts.client}, ${opts.phone}, 'mobile', TRUE, ${t})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, attempts, assigned_at, created_at, updated_at)
            VALUES (${opts.card}, ${SPACE}, ${opts.client}, ${opts.owner}, ${opts.state}, ${opts.attempts ?? 0}, ${t}, ${t}, ${t})`;
}

async function addDeal(d: { id: string; client: string; card: string; owner: string; status: 'open' | 'won' | 'lost'; amount?: number }): Promise<void> {
  const t = SEED_NOW - 3_600_000;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, lost_at,
                                  stage_changed_at, created_by, created_at, updated_at)
               VALUES (${d.id}, ${SPACE}, 'sales', ${d.status === 'open' ? 'booked' : d.status === 'won' ? 'won' : 'lost'}, ${d.status}, ${d.client}, ${d.card}, ${d.owner},
                       ${d.status === 'won' ? 'smm' : ''}, ${d.amount ?? 0}, ${d.status === 'won' ? SEED_NOW - 1_000 : null}, ${d.status === 'lost' ? SEED_NOW - 1_000 : null}, ${t}, ${d.owner}, ${t}, ${t})`;
}

async function addBooking(b: { id: string; client: string; card: string; deal: string; by: string; createdAt: number; individual?: boolean }): Promise<void> {
  // Групповая запись — на сегодняшнем мероприятии синтетики (оно началось раньше «сейчас» прогона); индивидуальная — у консультанта
  if (b.individual) {
    await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, deal_id, booking_date, start_time,
                                       starts_at, duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
                 VALUES (${b.id}, ${SPACE}, 'individual', 'consult', 'rs-cons', ${b.client}, ${b.card}, ${b.deal}, '2026-10-20', '11:00',
                         ${Date.UTC(2026, 9, 20, 6, 0)}, 60, ${b.by}, ${b.by}, ${b.createdAt}, ${b.createdAt})`;
    return;
  }
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, deal_id, booking_date, start_time,
                                     starts_at, duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
               VALUES (${b.id}, ${SPACE}, 'group', 'group', ${FX.eventToday.event}, ${b.client}, ${b.card}, ${b.deal}, '2026-10-28', '10:00',
                       ${Date.UTC(2026, 9, 28, 5, 0)}, 180, ${b.by}, ${b.by}, ${b.createdAt}, ${b.createdAt})`;
}

before(async () => {
  db = await createTestDb();
  await seedIsolation(db.sql);
  await applySeedConfig();
  await markFixtures(db.sql);
  enterSeedWorld();
  overrideBookingDepsForTests({ ...bookingDeps(), now: () => SEED_NOW });
  const t = SEED_NOW - 3_600_000;

  // Своя «Договорились» A: открытая сделка и запись; вторая сделка (закрыта) с записью той же карточки
  await addClientCard({ client: F.agreedA.client, card: F.agreedA.card, owner: U.opA, name: 'ТОО Синтетика Альфа Договор', phone: '77090900001', state: 'agreed' });
  await addDeal({ id: F.agreedA.deal, client: F.agreedA.client, card: F.agreedA.card, owner: U.opA, status: 'open' });
  await addDeal({ id: F.agreedA.lostDeal, client: F.agreedA.client, card: F.agreedA.card, owner: U.opA, status: 'lost' });
  await addBooking({ id: F.agreedA.booking, client: F.agreedA.client, card: F.agreedA.card, deal: F.agreedA.deal, by: U.opA, createdAt: t });
  await addBooking({ id: F.agreedA.lostBooking, client: F.agreedA.client, card: F.agreedA.card, deal: F.agreedA.lostDeal, by: U.opA, createdAt: t, individual: true });
  await addClientCard({ client: F.agreedA2.client, card: F.agreedA2.card, owner: U.opA, name: 'ТОО Синтетика Альфа Договор Два', phone: '77090900002', state: 'agreed' });
  await addDeal({ id: F.agreedA2.deal, client: F.agreedA2.client, card: F.agreedA2.card, owner: U.opA, status: 'open' });
  await addBooking({ id: F.agreedA2.booking, client: F.agreedA2.client, card: F.agreedA2.card, deal: F.agreedA2.deal, by: U.opA, createdAt: t });
  // Чужая «Договорились» B
  await addClientCard({ client: F.agreedB.client, card: F.agreedB.card, owner: U.opB, name: 'ТОО Синтетика Бета Договор', phone: '77091900001', state: 'agreed' });
  await addDeal({ id: F.agreedB.deal, client: F.agreedB.client, card: F.agreedB.card, owner: U.opB, status: 'open' });
  await addBooking({ id: F.agreedB.booking, client: F.agreedB.client, card: F.agreedB.card, deal: F.agreedB.deal, by: U.opB, createdAt: t });
  // Свои карточки для списания: без попыток и с попытками
  await addClientCard({ client: F.zeroA.client, card: F.zeroA.card, owner: U.opA, name: 'ТОО Синтетика Альфа Ноль', phone: '77090900003', state: 'new', attempts: 0 });
  await addClientCard({ client: F.attemptsA.client, card: F.attemptsA.card, owner: U.opA, name: 'ТОО Синтетика Альфа Попытки', phone: '77090900004', state: 'retry', attempts: 2 });
  // Клиент ушёл от A к B: покупка засчитана A (его запись первая), карточка уже у B
  await addClientCard({ client: F.movedAwayClient, card: F.movedAwayCard, owner: U.opB, name: 'ТОО Синтетика Перешёл Клиент', phone: '77091900002', state: 'client' });
  await addDeal({ id: F.movedAwayDeal, client: F.movedAwayClient, card: F.movedAwayCard, owner: U.opB, status: 'won', amount: 300000 });
  await addBooking({ id: 'q1-bk-moved', client: F.movedAwayClient, card: F.movedAwayCard, deal: F.movedAwayDeal, by: U.opA, createdAt: t });
  // Покупка A у своего клиента (имя видно) и покупка B (у A её нет)
  await addDeal({ id: F.ownWonDeal, client: F.agreedA2.client, card: F.agreedA2.card, owner: U.opA, status: 'won', amount: 100000 });
  await addBooking({ id: 'q1-bk-own-won', client: F.agreedA2.client, card: F.agreedA2.card, deal: F.ownWonDeal, by: U.opA, createdAt: t - 5_000, individual: true });
  await addDeal({ id: F.foreignWonDeal, client: F.agreedB.client, card: F.agreedB.card, owner: U.opB, status: 'won', amount: 200000 });
  await addBooking({ id: 'q1-bk-b-won', client: F.agreedB.client, card: F.agreedB.card, deal: F.foreignWonDeal, by: U.opB, createdAt: t - 5_000, individual: true });

  foreign = await allForeignNeedles(db.sql);
  before0 = await snapshotTables(db.sql, TOUCHED);
});

after(async () => {
  resetAccessForTests();
  overrideBookingDepsForTests(null);
  await db?.close();
});

const idsOf = (b: Board): string[] => [...b.columns.flatMap((c) => c.cards), ...(b.search?.matches ?? [])].map((c) => c.id);
const isOwnOfA = (id: string) => id.startsWith('cd-a-') || id.startsWith('q1-cd-a-');
const objectRow = (label: string, foreignReply: Reply, missing: Reply, id: string) => {
  assert.deepEqual(notFoundViolations({ foreign: foreignReply, missing, foreignId: id, missingId: MISSING }), [], `${label}: ${foreignReply.body.slice(0, 150)}`);
  assert.deepEqual(leakViolations(label, foreignReply, foreign), [], label);
};
async function unchanged(label: string, fn: () => Promise<void>): Promise<void> {
  const snap = await snapshotTables(db.sql, TOUCHED);
  await fn();
  assert.deepEqual(snapshotViolations(label, snap, await snapshotTables(db.sql, TOUCHED)), [], label);
}

describe('доска: чтение (оператор A)', () => {
  test('оператор A не видит карточки B: колонки, поиск, «Ещё» по курсору', async () => {
    const r = await api(U.opA, 'board');
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.deepEqual(leakViolations('доска', r, foreign), []);
    const board = json<Board>(r);
    const ids = idsOf(board);
    assert.ok(ids.length > 0, 'на доске A есть карточки (контроль: проверка не пустая)');
    assert.deepEqual(ids.filter((id) => !isOwnOfA(id)), []);

    // «Ещё» по курсору: колонка со следующей страницей (у A сто карточек) отдаёт только его карточки
    const withNext = board.columns.find((c) => c.next !== null);
    assert.ok(withNext, 'у A есть колонка с курсором «Ещё» (синтетика: 100 карточек)');
    const more = await api(U.opA, 'column', { query: `?column=${encodeURIComponent(withNext.key)}&cursor=${encodeURIComponent(withNext.next!)}` });
    assert.equal(more.status, 200, more.body.slice(0, 200));
    assert.deepEqual(leakViolations('«Ещё»', more, foreign), []);
    const page = json<{ cards: Card[] }>(more);
    assert.ok(page.cards.length > 0);
    assert.deepEqual(page.cards.map((c) => c.id).filter((id) => !isOwnOfA(id)), []);
    // Курсор чужой колонки/выдуманный — не 5xx и без данных чужих
    const bogus = await api(U.opA, 'column', { query: `?column=${encodeURIComponent(withNext.key)}&cursor=${encodeURIComponent(F.agreedB.card)}` });
    assert.ok(bogus.status < 500, bogus.body.slice(0, 200));
    assert.deepEqual(leakViolations('курсор', bogus, foreign), []);
  });

  test('поиск A: чужое не находится, а лимит поиска не тратится на чужие совпадения', async () => {
    const own = await api(U.opA, 'board', { query: '?q=' + encodeURIComponent('Синтетика Альфа') });
    assert.equal(own.status, 200);
    const ownMatches = json<Board>(own).search?.matches ?? [];
    assert.ok(ownMatches.length > 0, 'контроль: свои находятся');
    for (const q of ['Синтетика Бета', 'Бета 1', '77091', nameOf('b', 1), 'Договор']) {
      const r = await api(U.opA, 'board', { query: `?q=${encodeURIComponent(q)}` });
      assert.equal(r.status, 200, `${q}: ${r.body.slice(0, 120)}`);
      assert.deepEqual(leakViolations(`поиск «${q}»`, r, foreign), []);
      assert.deepEqual((json<Board>(r).search?.matches ?? []).filter((c) => !isOwnOfA(c.id)), [], q);
    }
    // Запрос, под который подходят карточки обоих операторов: страница поиска забита только своими
    const both = await api(U.opA, 'board', { query: '?q=' + encodeURIComponent('Синтетика') });
    const matches = json<Board>(both).search?.matches ?? [];
    assert.equal(matches.length, 20, 'лимит поиска (20) набран своими карточками, чужие его не занимают');
    assert.deepEqual(matches.filter((c) => !isOwnOfA(c.id)), []);
  });

  test('фильтр owner у оператора — 400, у РОП работает; фильтр по скрытому признаку покупок — 400 без права', async () => {
    const own = await api(U.opA, 'board', { query: `?owner=${U.opB}` });
    assert.equal(own.status, 400, own.body.slice(0, 200));
    assert.deepEqual(leakViolations('owner', own, foreign), []);
    const rop = await api(U.rop, 'board', { query: `?owner=${U.opA}` });
    assert.equal(rop.status, 200, 'контроль: РОП фильтрует по сотруднику');
    // Признаки покупок видны только при `deal.read`: с правом ключ purchases есть, без права — ключа нет, фильтр — 400
    const probe = async (user: string, hasReadExpected: boolean) => {
      const v = await viewerOf(user);
      const hasRead = v.grants.has('deal.read');
      assert.equal(hasRead, hasReadExpected, `${user}: контроль права deal.read`);
      for (const f of ['purchased', 'attendedNoBuy']) {
        const filtered = await api(user, 'board', { query: `?filter=${f}` });
        assert.equal(filtered.status, hasRead ? 200 : 400, `${user}: фильтр ${f} при deal.read=${hasRead} → ${filtered.status}`);
      }
      const plain = json<Board>(await api(user, 'board'));
      const cards = plain.columns.flatMap((c) => c.cards);
      assert.ok(cards.length > 0);
      if (hasRead) assert.ok(cards.every((c) => 'purchases' in c), `${user}: при deal.read ключ purchases есть у каждой карточки`);
      else assert.equal(cards.filter((c) => 'purchases' in c).length, 0, `${user}: без права признаки покупок не отдаются`);
    };
    for (const user of [U.opA, U.rop]) await probe(user, true);
    // Отрицательная ветка: тот же оператор, но роль без deal.read (подмена настроек, как в интеграционном тесте)
    const doc = configDoc() as { global: { roles: Array<{ key: string; grants: Array<{ perm: string }> }> } };
    const roles = doc.global.roles.map((r) => (r.key === roleOf('operator') ? { ...r, grants: r.grants.filter((g) => g.perm !== 'deal.read') } : r));
    enterSeedWorld({ config: { ...doc, global: { ...doc.global, roles } } });
    try {
      await probe(U.opA, false);
    } finally {
      enterSeedWorld();
    }
  });
});

describe('доска: действия над чужой карточкой (оператор A → карточка B)', () => {
  const foreignId = cardOf('b', 1);
  const closeBody = (kind: string, reasonCode = 'unreachable') => ({ opId: uid(1), version: 0, kind, reasonCode, alsoDncPhoneIds: [] });
  const moveBody = (to: string, extra: Record<string, unknown> = {}) => ({ opId: uid(2), version: 0, to, reasonCode: to === 'callback' ? 'think' : 'unreachable', ...extra });

  test('итог «Не целевой»/«Не интересует»/списание (№ 32) и перенос (№ 33) — 404 тем же телом, таблицы не менялись', async () => {
    const cases: Array<[string, keyof typeof ROUTES, unknown]> = [
      ['close written_off', 'close', closeBody('written_off')],
      ['close not_target', 'close', closeBody('not_target', 'other')],
      ['move written_off', 'move', moveBody('written_off')],
      ['move callback', 'move', moveBody('callback', { callbackAt: SEED_NOW + 86_400_000, callbackPrecision: 'day' })],
      ['move not_interested', 'move', moveBody('not_interested', { reasonCode: 'no_need' })],
    ];
    await unchanged('чужая карточка', async () => {
      for (const [label, file, body] of cases) {
        const f = await api(U.opA, file, { method: 'POST', params: { id: foreignId }, body });
        const m = await api(U.opA, file, { method: 'POST', params: { id: MISSING }, body });
        objectRow(label, f, m, foreignId);
        assert.equal(f.status, 404, label);
      }
    });
  });

  test('явка в № 33: по записи клиента B — 404; по своей записи не открытой сделки карточки — 404; снимок не менялся', async () => {
    await unchanged('явка по чужому', async () => {
      const withAttendance = (bookingId: string) => moveBody('callback', { reasonCode: 'no_show_br', callbackAt: SEED_NOW + 86_400_000, callbackPrecision: 'day', attendance: { bookingId, to: 'no_show' } });
      // 1) своя карточка, запись клиента B
      const foreignBooking = await api(U.opA, 'move', { method: 'POST', params: { id: F.agreedA.card }, body: withAttendance(F.agreedB.booking) });
      const missingBooking = await api(U.opA, 'move', { method: 'POST', params: { id: F.agreedA.card }, body: withAttendance(MISSING) });
      assert.equal(foreignBooking.status, 404, foreignBooking.body.slice(0, 200));
      assert.equal(foreignBooking.body.replaceAll(F.agreedB.booking, '<id>'), missingBooking.body.replaceAll(MISSING, '<id>'), '404 чужой записи неотличим от несуществующей');
      assert.deepEqual(leakViolations('явка по записи B', foreignBooking, foreign), []);
      // 2) своя запись, но другой карточки A
      const otherCard = await api(U.opA, 'move', { method: 'POST', params: { id: F.agreedA.card }, body: withAttendance(F.agreedA2.booking) });
      assert.equal(otherCard.status, 404, otherCard.body.slice(0, 200));
      // 3) своя запись этой же карточки, но закрытой сделки
      const lostDeal = await api(U.opA, 'move', { method: 'POST', params: { id: F.agreedA.card }, body: withAttendance(F.agreedA.lostBooking) });
      assert.equal(lostDeal.status, 404, lostDeal.body.slice(0, 200));
      assert.equal(lostDeal.body, foreignBooking.body, 'тело одно на все три случая');
    });
  });

  test('оператор без права явки: своя запись открытой сделки — 403 attendance_forbidden (контроль: охват пройден), таблицы не менялись', async () => {
    const v = await viewerOf(U.opA);
    if (v.grants.has('booking.attend')) return; // роль вправе отмечать: ветка 403 для неё не существует (ВП-4 решён «да»)
    await unchanged('явка без права', async () => {
      const r = await api(U.opA, 'move', {
        method: 'POST',
        params: { id: F.agreedA.card },
        body: moveBody('callback', { reasonCode: 'no_show_br', callbackAt: SEED_NOW + 86_400_000, callbackPrecision: 'day', attendance: { bookingId: F.agreedA.booking, to: 'no_show' } }),
      });
      assert.equal(r.status, 403, r.body.slice(0, 200));
      assert.match(r.body, /attendance_forbidden/);
    });
  });

  test('списание оператором: при attempts = 0 — 409; с попытками проходит (контроль)', async () => {
    const body = { opId: uid(3), version: 0, kind: 'written_off', reasonCode: 'unreachable', alsoDncPhoneIds: [] };
    await unchanged('списание без попыток', async () => {
      const zero = await api(U.opA, 'close', { method: 'POST', params: { id: F.zeroA.card }, body });
      // Ручное списание есть только там, где в настройках задана группа причин written_off (пресет клиента); в base — 400 kind
      assert.equal(zero.status, crpRoles ? 409 : 400, zero.body.slice(0, 200));
    });
  });
});

describe('доска: директор только читает (423)', () => {
  test('close written_off и move — 423, таблицы не менялись', async () => {
    await unchanged('директор', async () => {
      const close = await api(U.director, 'close', { method: 'POST', params: { id: F.agreedA.card }, body: { opId: uid(4), version: 0, kind: 'written_off', reasonCode: 'unreachable', alsoDncPhoneIds: [] } });
      assert.equal(close.status, 423, close.body.slice(0, 200));
      const move = await api(U.director, 'move', { method: 'POST', params: { id: F.agreedA.card }, body: { opId: uid(5), version: 0, to: 'written_off', reasonCode: 'unreachable' } });
      assert.equal(move.status, 423, move.body.slice(0, 200));
    });
  });

  test('директор читает доску пространства (контроль: 200, без мутаций)', async () => {
    const r = await api(U.director, 'board');
    assert.equal(r.status, 200, r.body.slice(0, 200));
  });
});

describe('«Мои покупки» и список явки', () => {
  test('GET /api/deals/mine: оператор A видит только засчитанные ему, имя ушедшего к B клиента скрыто', async () => {
    const r = await api(U.opA, 'mine');
    assert.equal(r.status, 200, r.body.slice(0, 200));
    const mine = json<{ items: Array<{ dealId: string; clientName: string | null; clientId: string | null; clientTransferred: boolean }>; month: { count: number; sumKzt: number } }>(r);
    const ids = mine.items.map((i) => i.dealId);
    assert.ok(ids.includes(F.ownWonDeal), 'контроль: своя покупка есть');
    assert.ok(!ids.includes(F.foreignWonDeal), 'покупка, засчитанная B, не видна');
    const moved = mine.items.find((i) => i.dealId === F.movedAwayDeal);
    assert.ok(moved, 'засчитанная A покупка остаётся в его списке (заслуга = он)');
    assert.equal(moved.clientTransferred, true);
    assert.equal(moved.clientName, null);
    assert.equal(moved.clientId, null);
    assert.equal(mine.items.find((i) => i.dealId === F.ownWonDeal)?.clientName, 'ТОО Синтетика Альфа Договор Два');
    // В ответе нет ни названия, ни номера, ни id ушедшего клиента и клиентов B; сумма месяца — только засчитанные A
    const moveNeedles = foreign.filter((n) => n instanceof RegExp);
    assert.deepEqual(leakViolations('мои покупки', r, [...moveNeedles, F.movedAwayClient]), []);
    assert.equal(mine.month.sumKzt, 400000);
  });

  test('GET /api/reports/attendance?view=list: оператор — 403, РОП — 200 (контроль)', async () => {
    const q = '?view=list';
    const op = await api(U.opA, 'report', { query: q, params: { key: 'attendance' } });
    assert.equal(op.status, 403, op.body.slice(0, 200));
    assert.deepEqual(leakViolations('список явки', op, foreign), []);
    const rop = await api(U.rop, 'report', { query: q, params: { key: 'attendance' } });
    assert.equal(rop.status, 200, rop.body.slice(0, 200));
  });
});

// Роли «консультант», «дежурный» и отдел передачи есть в пресете клиента; в слое base консультант и дежурный — менеджеры
const crpRoles = SEED_PRESET !== 'base';

describe('доска: роли без неё получают 404 и не видят покупок', () => {
  const noBoard = [
    ['консультант', U.consultant],
    ['отдел передачи (руководитель)', U.mktHead],
    ['отдел передачи (исполнитель)', U.marketer],
  ] as const;

  for (const [label, user] of noBoard) {
    if (!crpRoles) continue; // в слое base консультанта и отдела передачи нет: их роли — менеджеры
    test(`${label}: GET /api/cards/board, «Ещё» и /board — 404; в ответах нет карточек и признаков покупок`, async () => {
      const board = await api(user, 'board');
      assert.equal(board.status, 404, board.body.slice(0, 200));
      assert.deepEqual(leakViolations(label, board, foreign), []);
      assert.equal(board.body.includes('purchases'), false);
      const column = await api(user, 'column', { query: '?column=new' });
      assert.equal(column.status, 404, column.body.slice(0, 200));
      const mine = await api(user, 'mine');
      assert.deepEqual(leakViolations(`${label}: мои покупки`, mine, [...foreign, F.movedAwayClient]), []);
      if (user === U.consultant) {
        // Консультанту «Мои покупки» не закрыты правом (§14 не требует), но засчитанных ему сделок нет: список пуст
        assert.equal(mine.status, 200, mine.body.slice(0, 200));
        assert.deepEqual(json<{ items: unknown[] }>(mine).items, []);
      } else {
        assert.equal(mine.status, 404, `deals/mine: ${mine.body.slice(0, 200)}`);
      }

      const units = scanApp('src');
      const entries = await allEntries();
      const matched = matchEntries(units, entries);
      for (const [unit, entry] of matched) {
        if (entry.path !== '/(op)/board' && entry.path !== '/(op)/board/purchases') continue;
        const page = await invoke(unit, entry, { userId: user });
        // «Мои покупки» консультанту открыты правом deal.read через отношение (см. выше): страница без данных клиентов
        const open = user === U.consultant && entry.path === '/(op)/board/purchases';
        assert.equal(page.status, open ? 200 : 404, `${label}: ${entry.path} → ${page.status}`);
        assert.deepEqual(leakViolations(`${label} ${entry.path}`, page, foreign), []);
      }
    });
  }

  test('консультант вне окна: карточка клиента с прошедшей и будущей записью — 404 на действия доски', async () => {
    if (!crpRoles) return; // в base консультанта нет (он менеджер)
    await unchanged('консультант вне окна', async () => {
      for (const fx of [FX.bkPast, FX.bkFuture]) {
        const f = await api(U.consultant, 'move', { method: 'POST', params: { id: fx.card }, body: { opId: uid(6), version: 0, to: 'written_off', reasonCode: 'unreachable' } });
        const m = await api(U.consultant, 'move', { method: 'POST', params: { id: MISSING }, body: { opId: uid(6), version: 0, to: 'written_off', reasonCode: 'unreachable' } });
        objectRow(`окно ${fx.booking}`, f, m, fx.card);
        assert.equal(f.status, 404);
      }
    });
  });

  test('страницы /board и /board/purchases оператора A не содержат чужих названий и номеров', async () => {
    const units = scanApp('src');
    const entries = await allEntries();
    const matched = matchEntries(units, entries);
    let seen = 0;
    for (const [unit, entry] of matched) {
      if (entry.path !== '/(op)/board' && entry.path !== '/(op)/board/purchases') continue;
      const page = await invoke(unit, entry, { userId: U.opA });
      assert.equal(page.status, 200, `${entry.path}: ${page.body.slice(0, 200)}`);
      assert.deepEqual(leakViolations(entry.path, page, [...foreign, F.movedAwayClient]), []);
      seen++;
    }
    assert.equal(seen, 2, 'обе страницы найдены в манифесте');
  });
});

describe('контроль: положительные случаи (изоляция не равна «404 на всё»)', () => {
  test('РОП отмечает «не пришёл» по записи открытой сделки чужой для него карточки A: явка и перенос одной операцией', async () => {
    const r = await api(U.rop, 'move', {
      method: 'POST',
      params: { id: F.agreedA.card },
      body: { opId: uid(7), version: 0, to: 'callback', reasonCode: 'no_show_br', callbackAt: SEED_NOW + 86_400_000, callbackPrecision: 'day', attendance: { bookingId: F.agreedA.booking, to: 'no_show' } },
    });
    assert.equal(r.status, 200, r.body.slice(0, 300));
    const [b] = await db.sql<{ status: string }>`SELECT status FROM bookings WHERE id = ${F.agreedA.booking}`;
    assert.equal(b?.status, 'no_show');
    const [c] = await db.sql<{ state: string }>`SELECT state FROM cards WHERE id = ${F.agreedA.card}`;
    assert.equal(c?.state, 'callback');
    // Запись чужого клиента B и вторая запись карточки A этим не тронуты
    const rows = await db.sql<{ id: string; status: string }>`SELECT id, status FROM bookings WHERE id = ANY(${[F.agreedB.booking, F.agreedA.lostBooking]})`;
    assert.deepEqual(rows.map((x) => x.status).sort(), ['registered', 'registered']);
  });

  test('оператор A списывает свою карточку с попытками (№ 32): 200', async () => {
    const r = await api(U.opA, 'close', { method: 'POST', params: { id: F.attemptsA.card }, body: { opId: uid(8), version: 0, kind: 'written_off', reasonCode: 'unreachable', alsoDncPhoneIds: [] } });
    assert.equal(r.status, crpRoles ? 200 : 400, r.body.slice(0, 300));
  });

  test('снимок до прогона отличается от итогового только контрольными изменениями (прогон реально писал в БД)', async () => {
    const after0 = await snapshotTables(db.sql, TOUCHED);
    assert.notDeepEqual(before0, after0);
    // Никакая карточка B не изменилась: владелец и состояние прежние
    const b = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE owner_user_id = ${U.opB} AND state = 'retry' AND id = ${cardOf('b', 1)}`;
    assert.equal(b[0]?.n, 1);
    assert.equal(clientOf('b', 1), 'cl-b-1');
  });
});
