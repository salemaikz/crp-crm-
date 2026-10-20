// Сид стенда на Postgres: пустая БД → полный набор; повтор → 0 изменений; ограничения схемы; отказ в production.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSeed, SeedRefusedError, STAND_FLAG, type SeedReport } from '../../../scripts/seed';
import { runSeedCommand, parseSeedArgs, type SeedCtx } from '../../../scripts/crmctl/seed';
import { verifyPassword } from '../../../src/server/platform/auth/password';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';

const NOW = Date.parse('2026-10-20T04:00:00Z'); // вторник, 09:00 в Астане
let db: TestDb;
let assets: string;
let first: SeedReport;
let snapshot: Record<string, number>;

const env = (extra: Record<string, string | undefined> = {}) => ({ ...process.env, NODE_ENV: 'test', CRM_ASSETS_DIR: assets, CRM_PHONE_HMAC_KEY: 'test-stand-key', ...extra });

async function counts(): Promise<Record<string, number>> {
  // Имена таблиц нельзя подставлять параметром, поэтому список записан прямо в запросе
  const rows = await db.sql<{ t: string; n: number }>`
      SELECT 'users' AS t, count(*)::int AS n FROM users
      UNION ALL SELECT 'memberships' AS t, count(*)::int AS n FROM memberships
      UNION ALL SELECT 'teams' AS t, count(*)::int AS n FROM teams
      UNION ALL SELECT 'resources' AS t, count(*)::int AS n FROM resources
      UNION ALL SELECT 'resource_schedule' AS t, count(*)::int AS n FROM resource_schedule
      UNION ALL SELECT 'resource_exceptions' AS t, count(*)::int AS n FROM resource_exceptions
      UNION ALL SELECT 'imports' AS t, count(*)::int AS n FROM imports
      UNION ALL SELECT 'clients' AS t, count(*)::int AS n FROM clients
      UNION ALL SELECT 'contacts' AS t, count(*)::int AS n FROM contacts
      UNION ALL SELECT 'client_phones' AS t, count(*)::int AS n FROM client_phones
      UNION ALL SELECT 'client_sources' AS t, count(*)::int AS n FROM client_sources
      UNION ALL SELECT 'cards' AS t, count(*)::int AS n FROM cards
      UNION ALL SELECT 'calls' AS t, count(*)::int AS n FROM calls
      UNION ALL SELECT 'assign_log' AS t, count(*)::int AS n FROM assign_log
      UNION ALL SELECT 'stop_list' AS t, count(*)::int AS n FROM stop_list
      UNION ALL SELECT 'notes' AS t, count(*)::int AS n FROM notes
      UNION ALL SELECT 'client_events' AS t, count(*)::int AS n FROM client_events
      UNION ALL SELECT 'event_series' AS t, count(*)::int AS n FROM event_series
      UNION ALL SELECT 'events' AS t, count(*)::int AS n FROM events
      UNION ALL SELECT 'event_duty' AS t, count(*)::int AS n FROM event_duty
      UNION ALL SELECT 'deals' AS t, count(*)::int AS n FROM deals
      UNION ALL SELECT 'bookings' AS t, count(*)::int AS n FROM bookings
      UNION ALL SELECT 'booking_history' AS t, count(*)::int AS n FROM booking_history
      UNION ALL SELECT 'handoffs' AS t, count(*)::int AS n FROM handoffs
      UNION ALL SELECT 'tasks' AS t, count(*)::int AS n FROM tasks
      UNION ALL SELECT 'config_revisions' AS t, count(*)::int AS n FROM config_revisions
      UNION ALL SELECT 'audit_log' AS t, count(*)::int AS n FROM audit_log`;
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

const one = async <T>(q: Promise<T[]>): Promise<T> => {
  const r = (await q)[0];
  assert.ok(r, 'нет строки');
  return r;
};

before(async () => {
  db = await createTestDb();
  assets = await mkdtemp(path.join(os.tmpdir(), 'crm-seed-assets-'));
});
after(async () => {
  await db.close();
  await rm(assets, { recursive: true, force: true });
});

test('сид на пустой БД: пресет, сотрудники, 500 клиентов, пароли сгенерированы и проходят вход', async () => {
  first = await runSeed({ env: env(), now: NOW });
  snapshot = await counts();
  assert.equal(first.config, 'applied');
  assert.ok(first.changes > 2000);
  assert.equal(snapshot.clients, 500);
  assert.equal(snapshot.cards, 500);

  assert.equal(first.accounts.length, 12);
  const passwords = first.accounts.map((a) => a.password);
  assert.ok(passwords.every((p) => typeof p === 'string' && p.length >= 12));
  assert.equal(new Set(passwords).size, 12);
  const admin = first.accounts.find((a) => a.key === 'admin');
  assert.ok(admin?.password);
  const row = await one(db.sql<{ passwordHash: string; isAdmin: boolean }>`SELECT password_hash, is_admin FROM users WHERE phone_digits = ${admin.phone}`);
  assert.equal(row.isAdmin, true);
  assert.equal(await verifyPassword(admin.password, row.passwordHash), true);
  assert.equal(await verifyPassword('wrong-password-1', row.passwordHash), false);
  // пароли нигде не лежат открытым текстом
  const leaked = await db.sql`SELECT 1 FROM users WHERE password_hash = ANY(${passwords as string[]})`;
  assert.equal(leaked.length, 0);
});

test('состав: роли, консультанты с графиком, дежурный, команда маркетинга', async () => {
  const roles = await db.sql<{ roleKey: string; n: number }>`SELECT role_key, count(*)::int AS n FROM memberships GROUP BY 1`;
  const byRole = Object.fromEntries(roles.map((r) => [r.roleKey, r.n]));
  assert.deepEqual(byRole, { operator: 5, rop: 2, consultant: 2, director: 1, marketing_head: 1 });
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM users WHERE is_admin`)).n, 1);
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM memberships WHERE role_key = 'operator' AND in_distribution`)).n, 5);

  const res = await db.sql<{ directions: string[]; windows: number }>`
    SELECT r.directions, (SELECT count(*)::int FROM resource_schedule s WHERE s.resource_id = r.id) AS windows FROM resources r ORDER BY r.sort`;
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.directions.length > 0 && r.windows === 10));
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM resource_exceptions`)).n, 1);

  const lead = await one(db.sql<{ role: string }>`SELECT m.role_key AS role FROM teams t JOIN memberships m ON m.user_id = t.lead_user_id WHERE t.key = 'marketing'`);
  assert.equal(lead.role, 'marketing_head');
  const duty = await db.sql`SELECT 1 FROM event_duty d JOIN users u ON u.id = d.user_id JOIN events e ON e.id = d.event_id WHERE u.phone_digits = '77091000003' AND e.starts_at > ${NOW}`;
  assert.ok(duty.length >= 1);
});

test('клиенты: только +7 709, состояния карточек, перезвоны сегодня и завтра', async () => {
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_phones WHERE digits !~ '^7709[2-9][0-9]{6}$'`)).n, 0);
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(DISTINCT digits)::int AS n FROM client_phones`)).n, snapshot.client_phones);
  const st = await db.sql<{ state: string; n: number }>`SELECT state, count(*)::int AS n FROM cards GROUP BY 1`;
  const by = Object.fromEntries(st.map((r) => [r.state, r.n]));
  assert.deepEqual(by, { new: 200, retry: 90, callback: 70, agreed: 40, client: 10, not_interested: 35, not_target: 25, do_not_call: 10, written_off: 20 });
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE owner_user_id IS NULL`)).n, 60);

  const days = await db.sql<{ d: string; n: number }>`
    SELECT to_char(to_timestamp(next_call_at / 1000.0) AT TIME ZONE 'Asia/Almaty', 'YYYY-MM-DD') AS d, count(*)::int AS n FROM cards WHERE state = 'callback' GROUP BY 1`;
  const dm = Object.fromEntries(days.map((r) => [r.d, r.n]));
  assert.ok((dm['2026-10-20'] ?? 0) > 0 && (dm['2026-10-21'] ?? 0) > 0, JSON.stringify(dm));

  // "Не звонить": номер в стоп-листе только как HMAC
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM stop_list`)).n, 10);
  // каждому оператору досталось по 28 новых карточек
  const perOp = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE state = 'new' AND owner_user_id IS NOT NULL GROUP BY owner_user_id`;
  assert.deepEqual(perOp.map((r) => r.n), [28, 28, 28, 28, 28]);
});

test('согласованность: итоги карточек совпадают со звонками, «Договорились» держится записью или задачей', async () => {
  const bad = await db.sql`
    SELECT c.id FROM cards c
     WHERE c.calls_total <> (SELECT count(*) FROM calls k WHERE k.card_id = c.id)
        OR c.no_answer_total <> (SELECT count(*) FROM calls k WHERE k.card_id = c.id AND k.outcome_kind = 'no_answer')
        OR (c.calls_total > 0 AND c.last_outcome_at <> (SELECT max(occurred_at) FROM calls k WHERE k.card_id = c.id))`;
  assert.equal(bad.length, 0);
  const lone = await db.sql`
    SELECT c.id FROM cards c WHERE c.state = 'agreed'
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.card_id = c.id AND b.status IN ('registered','confirmed'))
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = c.client_id AND t.status = 'open' AND t.source = 'agreement')`;
  assert.equal(lone.length, 0);
  // недозвоны: счётчик попыток равен числу подряд идущих недозвонов; на 3-м — «Списан»
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE state = 'retry' AND attempts NOT IN (1, 2)`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE state = 'written_off' AND close_reason_code NOT IN ('no_answer_limit', 'no_working_phone')`).length, 0);
  // у каждой карточки с владельцем есть запись в журнале раздачи, лимит дня (40) не превышен
  assert.equal(snapshot.assign_log, 440);
  const over = await db.sql`SELECT 1 FROM assign_log GROUP BY to_user_id, day HAVING count(*) > 40`;
  assert.equal(over.length, 0);
});

test('БР по четвергам: серия, несколько записей на мероприятие, явка и неявка в прошлом, сделки и задачи', async () => {
  const ev = await db.sql<{ date: string; n: number }>`
    SELECT e.event_date AS date, count(b.id)::int AS n FROM events e LEFT JOIN bookings b ON b.event_id = e.id AND b.status IN ('registered','confirmed')
     WHERE e.starts_at > ${NOW} GROUP BY 1 ORDER BY 1`;
  assert.ok(ev.length >= 4);
  assert.ok(ev.every((e) => new Date(`${e.date}T00:00:00Z`).getUTCDay() === 4), 'все мероприятия по четвергам');
  assert.ok(ev.filter((e) => e.n >= 2).length >= 3, 'на ближайших БР по нескольку записей');
  assert.ok((await db.sql`SELECT 1 FROM bookings WHERE status = 'attended'`).length >= 1);
  assert.ok((await db.sql`SELECT 1 FROM bookings WHERE status = 'no_show'`).length >= 1);
  assert.ok((await db.sql`SELECT 1 FROM bookings WHERE kind = 'individual' AND resource_id IS NOT NULL`).length >= 1);
  assert.ok((await db.sql`SELECT 1 FROM bookings WHERE kind = 'individual' AND resource_id IS NULL`).length >= 1, 'есть «серая» запись');
  assert.ok((snapshot.deals ?? 0) >= 10);
  assert.equal((await one(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE status = 'won' AND amount_kzt > 0 AND won_at IS NOT NULL`)).n, 10);
  assert.ok((snapshot.tasks ?? 0) > 50);
  assert.ok((snapshot.handoffs ?? 0) >= 1);
  const src = await db.sql<{ source: string }>`SELECT DISTINCT source FROM tasks`;
  for (const s of ['callback', 'manual', 'agreement', 'handoff', 'grey_unassigned']) assert.ok(src.some((r) => r.source === s), `есть задачи ${s}`);
});

test('повторный сид: 0 изменений, ничего не дублируется, пароли не печатаются снова', async () => {
  const again = await runSeed({ env: env(), now: NOW });
  assert.equal(again.changes, 0, JSON.stringify(again.inserted));
  assert.equal(again.config, 'unchanged');
  assert.deepEqual(again.accounts, []);
  assert.deepEqual(await counts(), snapshot);
  // и в другой час того же дня, и со сдвигом на сутки: существующие строки не трогаются
  const later = await runSeed({ env: env(), now: NOW + 3 * 3_600_000 });
  assert.equal(later.changes, 0, JSON.stringify(later.inserted));
  assert.deepEqual(await counts(), snapshot);
});

test('отказ в production без флага; с флагом стенда — работает (на тех же данных ничего не меняет)', async () => {
  await assert.rejects(() => runSeed({ env: env({ NODE_ENV: 'production' }), now: NOW }), SeedRefusedError);
  assert.deepEqual(await counts(), snapshot);
  const r = await runSeed({ env: env({ NODE_ENV: 'production', CRM_STAND: '1' }), now: NOW, standFlag: true });
  assert.equal(r.changes, 0);
});

test('production с флагом, но без CRM_STAND=1 — отказ (до записи)', async () => {
  await assert.rejects(() => runSeed({ env: env({ NODE_ENV: 'production', CRM_STAND: undefined }), now: NOW, standFlag: true }), /CRM_STAND=1/);
  await assert.rejects(() => runSeed({ env: env({ NODE_ENV: 'production', CRM_STAND: 'yes' }), now: NOW, standFlag: true }), SeedRefusedError);
  assert.deepEqual(await counts(), snapshot);
});

test('база с не-синтетическими номерами клиентов — отказ, ничего не меняется', async () => {
  const c = await one(db.sql<{ id: string }>`SELECT client_id AS id FROM client_phones LIMIT 1`);
  await db.sql`INSERT INTO client_phones (id, client_id, digits, ext, kind, created_at) VALUES ('foreign-phone', ${c.id}, '77011234567', '', 'mobile', ${NOW})`;
  try {
    await assert.rejects(() => runSeed({ env: env({ NODE_ENV: 'production', CRM_STAND: '1' }), now: NOW, standFlag: true }), /вне синтетического блока 7709/);
    await assert.rejects(() => runSeed({ env: env(), now: NOW }), SeedRefusedError);
  } finally {
    await db.sql`DELETE FROM client_phones WHERE id = 'foreign-phone'`;
  }
  assert.deepEqual(await counts(), { ...snapshot });
});

test('настройки изменены не пресетом или применял не сид — отказ', async () => {
  const copy = async (source: string): Promise<void> => {
    await db.sql`INSERT INTO config_revisions (id, scope, rev, schema_version, doc, hash, source, note, author_id, created_at)
      SELECT 'manual-rev', scope, rev + 1, schema_version, doc, hash, ${source}, 'вручную', NULL, ${NOW}
        FROM config_revisions WHERE scope = 'global' ORDER BY rev DESC LIMIT 1`;
  };
  await copy('cli');
  try {
    await assert.rejects(() => runSeed({ env: env(), now: NOW }), /менялись не пресетом/);
  } finally {
    await db.sql`DELETE FROM config_revisions WHERE id = 'manual-rev'`;
  }
  await db.sql`INSERT INTO users (id, phone_digits, name, password_hash, is_admin, created_at) VALUES ('real-user', '77011112233', 'Синтетик', 'x', false, ${NOW})`;
  try {
    await assert.rejects(() => runSeed({ env: env(), now: NOW }), /применял не сид/);
  } finally {
    await db.sql`DELETE FROM users WHERE id = 'real-user'`;
  }
  assert.deepEqual(await counts(), snapshot);
  assert.equal((await runSeed({ env: env(), now: NOW })).changes, 0, 'после уборки сид снова работает');
});

test('пароль из окружения: проверяется политикой, в отчёте не возвращается', async () => {
  await assert.rejects(() => runSeed({ env: env({ CRM_SEED_PASSWORD: '12345678' }), now: NOW }), /политику/);
});

test('crmctl seed: аргументы, отказ до открытия БД, вывод паролей', async () => {
  assert.deepEqual(parseSeedArgs([STAND_FLAG, '--clients', '50', '--seed=x']).opts, { standFlag: true, clients: 50, seed: 'x' });
  assert.throws(() => parseSeedArgs(['--nope']), /неизвестный флаг/);
  const out: string[] = [];
  const err: string[] = [];
  let opened = 0;
  const ctx = (e: Record<string, string | undefined>): SeedCtx => ({
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    openDb: async () => {
      opened++;
      return async () => {};
    },
    env: e,
    now: () => NOW,
  });
  assert.equal(await runSeedCommand(['--help'], ctx(env())), 0);
  assert.equal(await runSeedCommand(['--clients', 'много'], ctx(env())), 1);
  assert.equal(await runSeedCommand([], ctx(env({ NODE_ENV: 'production' }))), 1);
  assert.match(err.join('\n'), /--i-know-this-is-a-stand/);
  assert.equal(await runSeedCommand([STAND_FLAG], ctx(env({ NODE_ENV: 'production', CRM_STAND: undefined }))), 1);
  assert.match(err.join('\n'), /CRM_STAND=1/);
  assert.equal(opened, 0, 'отказ раньше открытия БД');
  out.length = 0;
  assert.equal(await runSeedCommand([], ctx(env())), 0);
  assert.ok(out.some((l) => l.includes('без изменений')));
  assert.equal(opened, 1);
});
