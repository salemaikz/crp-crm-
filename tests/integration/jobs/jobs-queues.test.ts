// Очереди webhook_inbox и push_outbox, чистка платформы (worker-design §5, §7).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemActor } from '../../../src/server/access';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { createTestDb } from '../../../src/server/platform/db/testing';
import { purgeInvites, purgePushOutbox, purgeSessions, runQueuePass } from '../../../src/server/platform/jobs';
import type { QueueHandler, QueueSpec } from '../../../src/server/platform/jobs';

let db: TestDb;
const NOW = Date.parse('2026-10-28T06:00:00Z');
const actor = { kind: 'system', job: 'test', now: NOW } as SystemActor;
const ctl = new AbortController();
const log = { info() {}, warn() {} };

function spec(handlers: Record<string, QueueHandler>, over: Partial<QueueSpec> = {}): QueueSpec {
  return { name: 'webhook_inbox', batch: 20, leaseMs: 60_000, maxAttempts: 3, handlers: new Map(Object.entries(handlers)), enabled: () => true, writes: 'business', ...over };
}
const pass = (s: QueueSpec, now = NOW) => runQueuePass(db, s, { actor, now: () => now, signal: ctl.signal, log });

before(async () => {
  db = await createTestDb();
  await db.sql`INSERT INTO integrations (id, plugin_id, created_at, updated_at) VALUES ('int-1', 'demo.plugin', ${NOW}, ${NOW}), ('int-2', 'other.plugin', ${NOW}, ${NOW})`;
});
after(async () => {
  await db.close();
});

async function seedHooks(n: number, integration = 'int-1', prefix = 'h'): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.sql`INSERT INTO webhook_inbox (id, integration_id, dedupe_key, kind, next_at, received_at) VALUES (${`${prefix}-${i}`}, ${integration}, ${`${prefix}-${i}`}, 'evt', ${NOW}, ${NOW})`;
  }
}

test('30 строк, два параллельных прохода — каждая обработана один раз', async () => {
  await seedHooks(30);
  const seen: string[] = [];
  const s = spec({ 'demo.plugin': async (_a, item) => (seen.push(item.id), { status: 'done' }) }, { batch: 10 });
  for (let round = 0; round < 3; round++) await Promise.all([pass(s), pass(s)]);
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30);
  const [c] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM webhook_inbox WHERE state = 'done' AND processed_at IS NOT NULL`;
  assert.equal(c!.n, 30);
});

test('retry: next_at растёт, после maxAttempts — failed; нет обработчика — no_handler', async () => {
  await seedHooks(1, 'int-1', 'r');
  await seedHooks(1, 'int-2', 'nh');
  const s = spec({ 'demo.plugin': async () => ({ status: 'retry', error: 'temp' }) });
  let now = NOW;
  const nextAts: number[] = [];
  for (let k = 0; k < 3; k++) {
    await pass(s, now);
    const [row] = await db.sql<{ nextAt: number; state: string; attempts: number }>`SELECT next_at, state, attempts FROM webhook_inbox WHERE id = 'r-0'`;
    nextAts.push(row!.nextAt);
    now = row!.nextAt + 1;
  }
  assert.ok(nextAts[1]! - NOW > nextAts[0]! - NOW, 'пауза растёт');
  const [r] = await db.sql<{ state: string; attempts: number; error: string }>`SELECT state, attempts, error FROM webhook_inbox WHERE id = 'r-0'`;
  assert.deepEqual(r, { state: 'failed', attempts: 3, error: 'temp' });
  const [n] = await db.sql<{ state: string; error: string }>`SELECT state, error FROM webhook_inbox WHERE id = 'nh-0'`;
  assert.deepEqual(n, { state: 'failed', error: 'no_handler' }); // нет обработчика: повторы, затем failed (строка не удаляется)
});

test('failed сразу и исключение обработчика; аренда не даёт взять строку дважды', async () => {
  await seedHooks(2, 'int-1', 'f');
  const s = spec({
    'demo.plugin': async (_a, item) => {
      if (item.id === 'f-0') return { status: 'failed', error: 'bad_signature' };
      throw new Error('текст не должен попасть в БД');
    },
  });
  await pass(s);
  const [a] = await db.sql<{ state: string; error: string }>`SELECT state, error FROM webhook_inbox WHERE id = 'f-0'`;
  const [b] = await db.sql<{ state: string; error: string; leaseUntil: number | null }>`SELECT state, error, lease_until FROM webhook_inbox WHERE id = 'f-1'`;
  assert.deepEqual(a, { state: 'failed', error: 'bad_signature' });
  assert.equal(b!.state, 'pending');
  assert.equal(b!.error, 'Error');
  assert.equal(b!.leaseUntil, null);
  // чужая аренда: строка с живой арендой не берётся
  await db.sql`UPDATE webhook_inbox SET lease_until = ${NOW + 60_000}, next_at = ${NOW} WHERE id = 'f-1'`;
  const stats = await pass(spec({}), NOW);
  assert.equal(stats.taken, 0);
});

test('push_outbox: sent, sent_at', async () => {
  await db.sql`INSERT INTO users (id, phone_digits, name, created_at) VALUES ('u1', '77090000001', 'Тест', ${NOW})`;
  await db.sql`INSERT INTO notifications (id, user_id, kind, not_before, created_at) VALUES ('n1', 'u1', 'k', ${NOW}, ${NOW})`;
  await db.sql`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('ps1', 'u1', 'https://x.invalid/1', 'a', 'b', ${NOW})`;
  await db.sql`INSERT INTO push_outbox (id, notification_id, subscription_id, next_at, created_at) VALUES ('po1', 'n1', 'ps1', ${NOW}, ${NOW})`;
  await pass(spec({ push: async () => ({ status: 'done' }) }, { name: 'push_outbox' }));
  const [row] = await db.sql<{ state: string; sentAt: number }>`SELECT state, sent_at FROM push_outbox WHERE id = 'po1'`;
  assert.deepEqual(row, { state: 'sent', sentAt: NOW });
});

test('purge платформы: просроченные сессии пачками, живые остаются; приглашения и push', async () => {
  await db.sql`INSERT INTO users (id, phone_digits, name, created_at) VALUES ('u2', '77090000002', 'Тест', ${NOW}) ON CONFLICT DO NOTHING`;
  await db.sql`INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
               SELECT md5(i::text) || md5((i + 1)::text), 'u2', ${NOW - 10_000_000}, ${NOW - 1000}, ${NOW - 10_000_000} FROM generate_series(1, 12000) i`;
  await db.sql`INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (${'a'.repeat(64)}, 'u2', ${NOW}, ${NOW + 1000}, ${NOW})`;
  assert.equal(await purgeSessions(db, NOW), 12000);
  const left = await db.sql<{ id: string }>`SELECT id FROM sessions WHERE user_id = 'u2'`;
  assert.deepEqual(left.map((r) => r.id), ['a'.repeat(64)]);

  const DAY = 86_400_000;
  await db.sql`INSERT INTO invites (id, token_hash, phone_digits, expires_at, created_at) VALUES
    ('i-old', ${'b'.repeat(64)}, '77090000003', ${NOW - 40 * DAY}, ${NOW - 41 * DAY}),
    ('i-new', ${'c'.repeat(64)}, '77090000004', ${NOW - 5 * DAY}, ${NOW - 6 * DAY})`;
  assert.equal(await purgeInvites(db, NOW), 1);
  assert.deepEqual((await db.sql<{ id: string }>`SELECT id FROM invites`).map((r) => r.id), ['i-new']);
  assert.equal(await purgePushOutbox(db, NOW), 0);
});

test('purge останавливается по signal между пачками', async () => {
  const c = new AbortController();
  c.abort();
  assert.equal(await purgeSessions(db, NOW + 10 * 86_400_000, c.signal), 0);
});
