// Общий приём вебхуков (INTEGRATIONS §4, дизайн §7.6): токен пути, verify, тест провайдера без записи,
// идемпотентность, пределы тела и строк, отметка «события идут», лимит частоты, маршрут Next.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { receiveWebhook, WEBHOOK_MAX_BODY_BYTES } from '../../../src/server/domain/integrations';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { POST } from '../../../src/app/api/hooks/[pluginId]/[token]/route';
import { GOOD, T0, deps, insertIntegration, tokenOf } from './helpers';

let db: TestDb;
const ON = tokenOf(1);
const OFF = tokenOf(2);
const NOAPPROVE = tokenOf(3);

before(async () => {
  db = await createTestDb();
  await insertIntegration(db.sql, { id: 'int-on', token: ON });
  await insertIntegration(db.sql, { id: 'int-off', token: OFF, enabled: false });
  await insertIntegration(db.sql, { id: 'int-noapprove', token: NOAPPROVE, approved: false });
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.sql`UPDATE integrations SET last_event_at = NULL`;
});

function req(body: unknown, headers: Record<string, string> = { 'x-test-auth': GOOD }): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://crm.test/api/hooks/messenger.wazzup/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text });
}
const send = (token: string, body: unknown, opts: { headers?: Record<string, string>; now?: number; pluginId?: string; flag?: boolean } = {}) =>
  receiveWebhook(deps({ now: () => opts.now ?? T0, flagOn: () => opts.flag ?? true }), { pluginId: opts.pluginId ?? 'messenger.wazzup', token, req: req(body, opts.headers) });
const inbox = async (integrationId: string) =>
  db.sql<{ dedupeKey: string; kind: string; state: string; payload: unknown }>`SELECT dedupe_key, kind, state, payload FROM webhook_inbox WHERE integration_id = ${integrationId} ORDER BY dedupe_key`;
const events = (...ids: string[]) => ({ events: ids.map((id) => ({ id, kind: 'status' })) });

test('событие пишется в inbox, повтор не задваивает, ответ 200 оба раза', async () => {
  const r1 = await send(ON, events('a', 'b'));
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true });
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  const r2 = await send(ON, events('b', 'a', 'a'));
  assert.equal(r2.status, 200);
  const rows = await inbox('int-on');
  assert.deepEqual(rows.map((r) => [r.dedupeKey, r.kind, r.state]), [['e:a', 'status', 'pending'], ['e:b', 'status', 'pending']]);
  assert.deepEqual(rows[0]!.payload, { id: 'a', kind: 'status' });
});

test('неизвестный токен, чужой плагин, неизвестный плагин, флаг выключен — одинаковый 404 без записи', async () => {
  const before = (await inbox('int-on')).length;
  const replies = [
    await send(tokenOf(9), events('z1')),
    await send(ON, events('z2'), { pluginId: 'telephony.beeline' }),
    await send(ON, events('z3'), { pluginId: 'messenger.nope' }),
    await send(ON, events('z4'), { flag: false }),
    await send('short', events('z5')),
  ];
  for (const r of replies) {
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not_found' });
  }
  assert.equal((await inbox('int-on')).length, before);
});

test('выключенное подключение: события — 404, тест провайдера {"test":true} — 200 без записи', async () => {
  assert.equal((await send(OFF, events('x'))).status, 404);
  const t = await send(OFF, { test: true }, { headers: {} });
  assert.equal(t.status, 200);
  assert.deepEqual(await inbox('int-off'), []);
  const [row] = await db.sql<{ lastEventAt: number | null }>`SELECT last_event_at FROM integrations WHERE id = 'int-off'`;
  assert.equal(row!.lastEventAt, null);
});

test('без отметки решения о передаче за рубеж — 404 (непригодно); неверная подлинность — 401 без записи', async () => {
  assert.equal((await send(NOAPPROVE, events('n'))).status, 404);
  assert.deepEqual(await inbox('int-noapprove'), []);
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  let bad: Response;
  try {
    bad = await send(ON, events('bad'), { headers: { 'x-test-auth': 'wrong' } });
  } finally {
    console.warn = warn;
  }
  // в лог — только плагин и код: без токена, тела и заголовков
  assert.deepEqual(logs.map((l) => JSON.parse(l)), [{ level: 'warn', code: 'webhook_bad_auth', pluginId: 'messenger.wazzup' }]);
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: 'unauthorized' });
  const notJson = await send(ON, 'не json');
  assert.equal(notJson.status, 401);
  assert.ok(!(await inbox('int-on')).some((r) => r.dedupeKey === 'e:bad'));
});

test('тело 256 КБ + 1 → 413; больше 500 строк → 413; пустой split → 200', async () => {
  const pad = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES);
  assert.equal((await send(ON, { events: [], pad })).status, 413);
  const many = await send(ON, events(...Array.from({ length: 501 }, (_, i) => `m${i}`)));
  assert.equal(many.status, 413);
  assert.ok(!(await inbox('int-on')).some((r) => r.dedupeKey.startsWith('e:m')));
  assert.equal((await send(ON, { events: [] })).status, 200);
});

test('last_event_at обновляется не чаще раза в минуту', async () => {
  const at = async () => (await db.sql<{ lastEventAt: number }>`SELECT last_event_at FROM integrations WHERE id = 'int-on'`)[0]!.lastEventAt;
  await send(ON, events('t1'), { now: T0 });
  assert.equal(await at(), T0);
  await send(ON, events('t2'), { now: T0 + 30_000 });
  assert.equal(await at(), T0);
  await send(ON, events('t3'), { now: T0 + 61_000 });
  assert.equal(await at(), T0 + 61_000);
});

test('лимит частоты на токен: 600 в минуту, дальше 429', async () => {
  const tok = tokenOf(77);
  const now = T0 + 10 * 60_000;
  for (let i = 0; i < 600; i++) {
    const r = await send(tok, { events: [] }, { now });
    assert.equal(r.status, 404);
  }
  const limited = await send(tok, { events: [] }, { now });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('маршрут Next: реестр продукта (у плагинов нет вебхуков) — 404 без записи, без Origin', async () => {
  const r = await POST(new Request(`https://crm.test/api/hooks/messenger.wazzup/${ON}`, { method: 'POST', body: JSON.stringify(events('route')) }), {
    params: Promise.resolve({ pluginId: 'messenger.wazzup', token: ON }),
  });
  assert.equal(r.status, 404);
  const r2 = await POST(new Request(`https://crm.test/api/hooks/telephony.manual/${ON}`, { method: 'POST', body: '{}' }), {
    params: Promise.resolve({ pluginId: 'telephony.manual', token: ON }),
  });
  assert.equal(r2.status, 404);
  assert.ok(!(await inbox('int-on')).some((x) => x.dedupeKey === 'e:route'));
});
