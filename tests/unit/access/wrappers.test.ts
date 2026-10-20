// Обёртки route/publicRoute/page/action без БД: Viewer подставляется, аудит не включён.
// next/headers подменяется областью запроса прогона изоляции: server action читает Origin из headers().
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LicenseState, Viewer } from '../../../src/server/access/types';

register('../../isolation/runner/hooks.mjs', import.meta.url);

const { action, page, publicRoute, route } = await import('../../../src/server/access/wrappers');
const { NotFoundError, UnauthorizedError } = await import('../../../src/server/access/errors');
const { overrideViewer } = await import('../../../src/server/access/current');
const { resetAccessForTests, testViewer, setViewerForTests } = await import('../../../src/server/access/testing');
const { presetRole } = await import('./helpers');
const { withRequestScope } = await import('../../isolation/runner/shims/nextHeaders');

const ORIGIN = 'http://crm.test';
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/cards/x`, { method, headers: method === 'GET' ? headers : { origin: ORIGIN, ...headers } });
const ctx = (params: Record<string, string> = { id: 'x' }) => ({ params: Promise.resolve(params) });
const v = (key: string | null, license: LicenseState = 'valid'): Viewer =>
  testViewer({ userId: `u-${key ?? 'none'}`, role: key ? presetRole(key) : null, license, spaceId: key ? 'sp-1' : null });

afterEach(() => resetAccessForTests());

/** Временные переменные окружения на время fn (NODE_ENV, APP_ORIGIN). */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, env[k]]));
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) delete env[k];
    else env[k] = val;
  }
  try {
    return await fn();
  } finally {
    for (const [k, val] of Object.entries(saved)) {
      if (val === undefined) delete env[k];
      else env[k] = val;
    }
  }
}

/** Вызов server action «внутри запроса» с такими заголовками. */
const inRequest = <T>(headers: Record<string, string>, fn: () => Promise<T>) => withRequestScope({ headers }, fn);
const SAME = { host: 'crm.test', origin: ORIGIN };

test('route: нет сессии → 401; чужой и несуществующий объект → одинаковые 404', async () => {
  overrideViewer(async () => {
    throw new UnauthorizedError();
  });
  const h = route({ perm: 'card.read', target: 'object' }, async () => ({ ok: true }));
  const r401 = await h(req('GET'), ctx());
  assert.equal(r401.status, 401);
  assert.deepEqual(await r401.json(), { error: 'unauthorized' });

  setViewerForTests(v('operator'));
  const missing = route({ perm: 'card.read', target: 'object' }, async () => {
    throw new NotFoundError();
  });
  const a = await missing(req('GET'), ctx({ id: 'nonexistent' }));
  const b = await missing(req('GET'), ctx({ id: 'foreign' }));
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.equal(await a.text(), await b.text());
  assert.equal(a.headers.get('cache-control'), 'no-store');
});

test('route: нет права — 404 для объекта, 403 для раздела', async () => {
  setViewerForTests(v('operator'));
  const obj = route({ perm: 'pool.read', target: 'object' }, async () => 1);
  const sec = route({ perm: 'pool.read' }, async () => 1);
  assert.equal((await obj(req('GET'), ctx())).status, 404);
  assert.equal((await sec(req('GET'), ctx())).status, 403);
});

test('route: роль «только чтение» и лицензия read_only/invalid/missing → 423 на мутации; чтение и D-054 проходят', async () => {
  const mutate = route({ perm: 'card.edit', target: 'object' }, async () => 'changed');
  const read = route({ perm: 'card.read', target: 'object' }, async () => 'data');
  const search = route({ perm: 'card.read' }, async () => 'found'); // поиск POST-ом — не мутация
  const security = route({ perm: 'authenticated', securityMutation: 'auth.logout_all' }, async () => 'out');
  for (const viewer of [v('director'), v('operator', 'read_only'), v('operator', 'invalid'), v('operator', 'missing')]) {
    setViewerForTests(viewer);
    const r = await mutate(req('PATCH'), ctx());
    assert.equal(r.status, 423, `${viewer.roleKey} ${viewer.license}`);
    assert.deepEqual(await r.json(), { error: 'read_only' });
    assert.equal((await read(req('GET'), ctx())).status, 200);
    assert.equal((await search(req('POST'), ctx())).status, 200);
    assert.equal((await security(req('POST'), ctx())).status, 200);
  }
  setViewerForTests(v('operator', 'grace'));
  assert.equal((await mutate(req('PATCH'), ctx())).status, 200);
});

test('route: мутация без Origin или с чужим Origin → 403 до чтения сессии', async () => {
  let asked = false;
  overrideViewer(async () => {
    asked = true;
    return v('rop');
  });
  const h = route({ perm: 'card.edit', target: 'object' }, async () => 'ok');
  const noOrigin = new Request(`${ORIGIN}/api/cards/x`, { method: 'POST' });
  assert.equal((await h(noOrigin, ctx())).status, 403);
  assert.equal((await h(req('POST', { origin: 'http://evil.test' }), ctx())).status, 403);
  assert.equal(asked, false);
  assert.equal((await h(req('POST'), ctx())).status, 200);
  // Sec-Fetch-Site: та же проверка, что у src/proxy.ts (auth/csrf.ts)
  assert.equal((await h(req('POST', { 'sec-fetch-site': 'cross-site' }), ctx())).status, 403);
  assert.equal((await h(req('POST', { 'sec-fetch-site': 'same-site' }), ctx())).status, 403);
  assert.equal((await h(req('POST', { 'sec-fetch-site': 'same-origin' }), ctx())).status, 200);
});

test('route: неожиданная ошибка → 500 без текста; данные → JSON, undefined → 204', async () => {
  setViewerForTests(v('rop'));
  const origError = console.error;
  console.error = () => {};
  try {
    const boom = route({ perm: 'card.read' }, async () => {
      throw Object.assign(new Error('duplicate key'), { detail: 'Key (digits)=(77090000000)' });
    });
    const r = await boom(req('GET'), ctx());
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'internal' });
  } finally {
    console.error = origError;
  }
  const data = route({ perm: 'card.read' }, async ({ params }) => ({ id: params.id }));
  assert.deepEqual(await (await data(req('GET'), ctx({ id: 'c1' }))).json(), { id: 'c1' });
  const empty = route({ perm: 'card.edit' }, async () => undefined);
  assert.equal((await empty(req('POST'), ctx())).status, 204);
});

test('publicRoute: без сессии; Origin проверяется по настройке', async () => {
  overrideViewer(async () => {
    throw new Error('сессия не должна читаться');
  });
  const login = publicRoute({ reason: 'auth', origin: 'check' }, async () => ({ ok: true }));
  const hook = publicRoute({ reason: 'webhook', origin: 'skip' }, async () => ({ ok: true }));
  const bare = new Request(`${ORIGIN}/api/hooks/x`, { method: 'POST' });
  assert.equal((await login(bare, ctx())).status, 403);
  assert.equal((await login(req('POST'), ctx())).status, 200);
  assert.equal((await login(req('POST', { 'sec-fetch-site': 'cross-site' }), ctx())).status, 403);
  assert.equal((await hook(bare, ctx())).status, 200);
});

test('action: результат или код ошибки; 423 для «только чтения»', async () => {
  const edit = action({ perm: 'card.edit', target: 'object' }, async (_c, id: string) => ({ id }));
  setViewerForTests(v('rop'));
  assert.deepEqual(await inRequest(SAME, () => edit('c1')), { ok: true, data: { id: 'c1' } });
  setViewerForTests(v('director'));
  assert.deepEqual(await inRequest(SAME, () => edit('c1')), { ok: false, error: 'read_only' });
  setViewerForTests(v('marketer'));
  assert.deepEqual(await inRequest(SAME, () => edit('c1')), { ok: false, error: 'not_found' });
  const exportAll = action({ perm: 'data.export_all', securityMutation: 'data.export_all' }, async () => 'file');
  setViewerForTests(v('director'));
  assert.deepEqual(await inRequest(SAME, () => exportAll()), { ok: true, data: 'file' });
});

test('action: Origin обязателен (D-095) — без него, чужой, cross-site → 403 до чтения сессии', async () => {
  let asked = false;
  overrideViewer(async () => {
    asked = true;
    return v('rop');
  });
  const edit = action({ perm: 'card.edit', target: 'object' }, async () => 'changed');
  // поиск — чтение, но action всё равно POST: Origin проверяется и для него
  const search = action({ perm: 'card.read' }, async () => 'found');
  const forbidden = { ok: false, error: 'forbidden' };
  assert.deepEqual(await edit(), forbidden, 'вне запроса Next — отказ');
  assert.deepEqual(await inRequest({ host: 'crm.test' }, () => edit()), forbidden);
  assert.deepEqual(await inRequest({ host: 'crm.test', origin: 'null' }, () => edit()), forbidden);
  assert.deepEqual(await inRequest({ host: 'crm.test', origin: 'http://evil.test' }, () => search()), forbidden);
  assert.deepEqual(await inRequest({ ...SAME, 'sec-fetch-site': 'cross-site' }, () => edit()), forbidden);
  assert.equal(asked, false);
  assert.deepEqual(await inRequest({ ...SAME, 'sec-fetch-site': 'same-origin' }, () => edit()), { ok: true, data: 'changed' });
});

test('action и route: APP_ORIGIN нормализуется; в production без APP_ORIGIN мутации отклоняются', async () => {
  setViewerForTests(v('rop'));
  const edit = action({ perm: 'card.edit', target: 'object' }, async () => 'changed');
  const h = route({ perm: 'card.edit', target: 'object' }, async () => 'ok');
  await withEnv({ APP_ORIGIN: `${ORIGIN}/` }, async () => {
    assert.deepEqual(await inRequest({ origin: ORIGIN }, () => edit()), { ok: true, data: 'changed' });
    assert.equal((await h(req('POST'), ctx())).status, 200);
  });
  await withEnv({ APP_ORIGIN: 'https://crm.example.test' }, async () => {
    // origin самого запроса при заданном APP_ORIGIN не используется
    assert.equal((await h(req('POST'), ctx())).status, 403);
    assert.deepEqual(await inRequest(SAME, () => edit()), { ok: false, error: 'forbidden' });
  });
  await withEnv({ NODE_ENV: 'production', APP_ORIGIN: undefined }, async () => {
    assert.equal((await h(req('POST'), ctx())).status, 403);
    assert.deepEqual(await inRequest(SAME, () => edit()), { ok: false, error: 'forbidden' });
    assert.equal((await h(req('GET'), ctx())).status, 200, 'чтение без Origin не трогается');
  });
});

test('page: нет сессии → переход на вход; нет права или объекта → notFound()', async () => {
  const p = page<{ id: string }, string>({ perm: 'card.read', target: 'object' }, async ({ props }) => {
    if (props.id === 'foreign') throw new NotFoundError();
    return `card ${props.id}`;
  });
  const digest = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return 'ok';
    } catch (e) {
      return String((e as { digest?: string }).digest ?? e);
    }
  };
  overrideViewer(async () => {
    throw new UnauthorizedError();
  });
  assert.match(await digest(() => p({ id: 'a' })), /^NEXT_REDIRECT;.*\/login/);
  setViewerForTests(v('operator'));
  assert.equal(await p({ id: 'a' }), 'card a');
  assert.match(await digest(() => p({ id: 'foreign' })), /NEXT_HTTP_ERROR_FALLBACK;404/);
  setViewerForTests(v('marketer'));
  const pool = page({ perm: 'pool.read' }, async () => 'pool');
  assert.match(await digest(() => pool({})), /NEXT_HTTP_ERROR_FALLBACK;404/);
});
