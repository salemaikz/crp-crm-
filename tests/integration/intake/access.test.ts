/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API в тестах читаются по путям */
// Доступ к приёму: ключи (неверный, отозванный, без разрешения), лимиты, размеры, закрытие снаружи и «не принимаем».
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { overrideAccessForTests, resetAccessForTests } from '../../../src/server/access/testing';
import { resetRateLimit } from '../../../src/server/platform/ratelimit';
import { systemActor } from '../../../src/server/access/systemActor';
import { revokeKey, uiKeys, createKey, listKeys } from '../../../src/server/domain/intake';
import { MAX_BODY_BYTES } from '../../../src/server/domain/intake';
import { POST as routePost } from '../../../src/app/api/ingest/v1/leads/route';
import { GET as routeGet } from '../../../src/app/api/ingest/v1/demand/route';
import { batch, counts, getDemand, installIntakeConfig, mkKey, ph, post, T0 } from './helpers';

let db: TestDb;
let key: string;
const ENV = ['INGEST_PUBLIC', 'INGEST_ACCEPTING'] as const;

before(async () => {
  db = await createTestDb();
  await installIntakeConfig();
  key = (await mkKey('open')).key;
});
after(async () => {
  await db.close();
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  resetAccessForTests();
  // Счётчик неудачных ключей живёт в памяти процесса; без доверенного IP все запросы теста — один «unknown»
  resetRateLimit('ingest:fail:unknown');
});

const code = async (r: Response) => ((await r.json()) as any).error?.code;
const ok = () => batch([{ name: 'ТОО Доступ', phones: [ph(1)] }]);

test('нет ключа, чужой, обрезанный, с неверным секретом → 401 одним ответом', async () => {
  const good = key.split('_');
  const wrongSecret = `${good[0]}_${good[1]}_${'A'.repeat(43)}`;
  const bodies = new Set<string>();
  for (const k of [null, 'crm1_abcdefgh_short', `crm1_zzzzzzzz_${'A'.repeat(43)}`, wrongSecret, 'Basic abc']) {
    const r = await post(k, ok(), k === 'Basic abc' ? { headers: { authorization: 'Basic abc' } } : {});
    assert.equal(r.status, 401);
    bodies.add(JSON.stringify(await r.json()));
  }
  assert.equal(bodies.size, 1, 'причина отказа не различается');
  assert.equal((await getDemand(null)).status, 401);
});

test('отозванный ключ → 401; другие ключи не затронуты', async () => {
  const a = await mkKey('open');
  const b = await mkKey('open');
  assert.equal((await post(a.key, ok())).status, 200);
  assert.equal(await revokeKey(systemActor('test', T0), a.prefix), true);
  assert.equal(await revokeKey(systemActor('test', T0), a.prefix), false);
  assert.equal((await post(a.key, ok())).status, 401);
  assert.equal((await getDemand(a.key)).status, 401);
  assert.equal((await post(b.key, ok())).status, 200);
});

test('в БД хэш секрета, а не ключ; ключ показывается только при создании', async () => {
  const k = await mkKey('open');
  const [row] = await db.sql<any>`SELECT * FROM ingest_keys WHERE prefix = ${k.prefix}`;
  const secret = k.key.split('_').slice(2).join('_');
  assert.match(row.keyHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes(secret));
  const info = (await listKeys(systemActor('test', T0))).find((i) => i.prefix === k.prefix);
  assert.ok(info && !JSON.stringify(info).includes(secret));
});

test('ключи managed=cli не попадают в список интерфейса', async () => {
  const cli = await mkKey('open');
  const { info } = await createKey(systemActor('test', T0), { spaceKey: 'sales', sourceKey: 'open', scopes: ['leads:write'], managed: 'ui' });
  const ui = (await uiKeys()).map((k) => k.prefix);
  assert.ok(ui.includes(info.prefix));
  assert.ok(!ui.includes(cli.prefix));
});

test('last_used_at обновляется не чаще раза в минуту', async () => {
  const k = await mkKey('open');
  const read = async () => (await db.sql<any>`SELECT last_used_at FROM ingest_keys WHERE prefix = ${k.prefix}`)[0].lastUsedAt as number | null;
  assert.equal(await read(), null);
  await getDemand(k.key);
  const first = await read();
  assert.ok(first !== null);
  await getDemand(k.key);
  assert.equal(await read(), first);
});

test('разрешения ключа: без leads:write приём → 403, без leads:demand потребность → 403', async () => {
  const onlyDemand = await mkKey('open', ['leads:demand']);
  const onlyWrite = await mkKey('open', ['leads:write']);
  const before = await counts(db);
  const r = await post(onlyDemand.key, ok());
  assert.equal(r.status, 403);
  assert.equal(await code(r), 'forbidden_scope');
  assert.deepEqual(await counts(db), before);
  assert.equal((await getDemand(onlyDemand.key)).status, 200);
  assert.equal((await getDemand(onlyWrite.key)).status, 403);
  assert.equal((await post(onlyWrite.key, ok())).status, 200);
});

test('лимит частоты: 60 запросов в минуту на ключ, дальше 429 с Retry-After', async () => {
  const k = await mkKey('open', ['leads:demand']);
  for (let i = 0; i < 60; i++) assert.equal((await getDemand(k.key)).status, 200, `запрос ${i + 1}`);
  const r = await getDemand(k.key);
  assert.equal(r.status, 429);
  assert.equal(await code(r), 'rate_limited');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  // другой ключ лимит не делит
  assert.equal((await getDemand(key)).status, 200);
});

test('перебор неверных ключей с одного адреса упирается в 429', async () => {
  const headers = { 'x-real-ip': '203.0.113.9' };
  process.env.TRUST_X_REAL_IP = '1';
  try {
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await post(`crm1_abcdefgh_${'B'.repeat(43)}`, ok(), { headers })).status;
    assert.equal(last, 429);
  } finally {
    delete process.env.TRUST_X_REAL_IP;
  }
});

test('Content-Type, размер тела и разбор JSON', async () => {
  const wrongType = await post(key, ok(), { headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  assert.equal(await code(wrongType), 'unsupported_media_type');
  const big = await post(key, null, { raw: JSON.stringify({ batchId: 'x', pad: 'a'.repeat(MAX_BODY_BYTES) }) });
  assert.equal(big.status, 413);
  assert.equal(await code(big), 'payload_too_large');
  const declared = await post(key, ok(), { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
  assert.equal(declared.status, 413);
  const broken = await post(key, null, { raw: '{"batchId": ' });
  assert.equal(broken.status, 400);
  assert.equal(await code(broken), 'invalid_json');
});

test('ошибки конверта: 400 с путями и кодами, без значений', async () => {
  const before = await counts(db);
  const r = await post(key, { batchId: 'не-uuid', items: [{ name: 'ТОО Секретное имя', phones: Array.from({ length: 11 }, (_, i) => ph(i)) }, 'строка'] });
  assert.equal(r.status, 400);
  const body: any = await r.json();
  assert.equal(body.error.code, 'validation_failed');
  assert.deepEqual(body.error.issues.map((i: any) => `${i.path}:${i.code}`).sort(), ['batchId:invalid_format', 'items.0.phones:too_many', 'items.1:invalid_type']);
  assert.ok(!JSON.stringify(body).includes('Секретное'));
  assert.equal((await post(key, { batchId: '3b0f6c1e-6a52-4c0e-9b8a-2f1d7c9e4a10', items: [] })).status, 400);
  const tooMany = await post(key, batch(Array.from({ length: 1001 }, (_, i) => ({ name: `ТОО ${i}`, phones: [ph(i)] }))));
  assert.equal(tooMany.status, 400);
  assert.equal(((await tooMany.json()) as any).error.issues[0].code, 'too_many');
  assert.deepEqual(await counts(db), before);
});

test('закрыто снаружи (D-155): через прокси с верным секретом — только при INGEST_PUBLIC=1; метка без секрета — подделка, закрыта всегда', async () => {
  const SECRET = 'synthetic-proxy-secret-0123456789abcdef';
  const prevSecret = process.env.CRM_PROXY_SECRET;
  process.env.CRM_PROXY_SECRET = SECRET;
  const viaProxy = { 'x-via-proxy': '1', 'x-proxy-secret': SECRET };
  const forged = { 'x-via-proxy': '1' };
  try {
    const before = await counts(db);
    for (const value of [undefined, '0', '', 'true']) {
      if (value === undefined) delete process.env.INGEST_PUBLIC;
      else process.env.INGEST_PUBLIC = value;
      const w = await post(key, ok(), { headers: viaProxy });
      assert.equal(w.status, 404, `INGEST_PUBLIC=${String(value)}`);
      assert.equal(await code(w), 'not_found');
      assert.equal((await getDemand(key, viaProxy)).status, 404);
    }
    assert.deepEqual(await counts(db), before);
    // из сети Docker (без меток прокси) работает
    assert.equal((await post(key, ok())).status, 200);
    // открытый приём (INGEST_PUBLIC=1) через настоящий прокси работает, ключ по-прежнему обязателен
    process.env.INGEST_PUBLIC = '1';
    assert.equal((await post(key, ok(), { headers: viaProxy })).status, 200);
    assert.equal((await post(null, ok(), { headers: viaProxy })).status, 401);
    // метка прокси без верного секрета — подделка: закрыто даже при INGEST_PUBLIC=1
    assert.equal((await post(key, ok(), { headers: forged })).status, 404);
    assert.equal((await post(key, ok(), { headers: { ...forged, 'x-proxy-secret': 'wrong' } })).status, 404);
  } finally {
    if (prevSecret === undefined) delete process.env.CRM_PROXY_SECRET;
    else process.env.CRM_PROXY_SECRET = prevSecret;
    delete process.env.INGEST_PUBLIC;
  }
});

test('маршруты обёрнуты publicRoute: те же ответы через route.ts', async () => {
  const mk = (url: string, init: RequestInit) => new Request(`http://crm-app:3000${url}`, init);
  const ctx = { params: Promise.resolve({}) };
  const closed = await routePost(mk('/api/ingest/v1/leads', { method: 'POST', headers: { 'x-via-proxy': '1', 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(ok()) }), ctx);
  assert.equal(closed.status, 404);
  assert.equal(closed.headers.get('cache-control'), 'no-store');
  const res = await routePost(mk('/api/ingest/v1/leads', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(ok()) }), ctx);
  assert.equal(res.status, 200);
  // Origin у машинного входа не проверяется
  assert.equal((await routeGet(mk('/api/ingest/v1/demand', { headers: { authorization: `Bearer ${key}` } }), ctx)).status, 200);
  assert.equal((await routeGet(mk('/api/ingest/v1/demand', {}), ctx)).status, 401);
});

test('приём выключен: лицензия read_only/invalid/missing и INGEST_ACCEPTING=0 → 423, ничего не пишется; повтор известной партии отдаётся', async () => {
  const known = ok();
  assert.equal((await post(key, known)).status, 200);
  const before = await counts(db);
  for (const license of ['read_only', 'invalid', 'missing'] as const) {
    overrideAccessForTests({ license: async () => license });
    const r = await post(key, batch([{ name: `ТОО Закрыто ${license}`, phones: [ph(7)] }]));
    assert.equal(r.status, 423, license);
    assert.equal(await code(r), 'not_accepting');
    assert.equal(((await (await getDemand(key)).json()) as any).accepting, false);
  }
  assert.deepEqual(await counts(db), before);
  assert.equal((await post(key, known)).status, 200, 'повтор партии идемпотентен и при закрытом приёме');
  resetAccessForTests();
  overrideAccessForTests({ license: async () => 'grace' });
  assert.equal((await post(key, batch([{ name: 'ТОО Льготный', phones: [ph(8)] }]))).status, 200);
  process.env.INGEST_ACCEPTING = '0';
  assert.equal((await post(key, batch([{ name: 'ТОО Выключен', phones: [ph(9)] }]))).status, 423);
  assert.equal((await db.sql`SELECT 1 FROM clients WHERE name IN ('ТОО Выключен', 'ТОО Закрыто read_only')`).length, 0);
});
