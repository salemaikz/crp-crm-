// logoResponse (D-333) без БД: заголовки, 200 / 304 / 404, кэш по ?v, без cookie.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logoResponse } from '../../../src/server/platform/brand';
import { readLogo, resetLogoCacheForTests } from '../../../src/server/platform/brand/logo';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="4"><rect width="10" height="4"/></svg>';
let dir: string;
const deps = (key: string | null = 'brand.svg') => ({ logoKey: async () => key, env: { CRM_ASSETS_DIR: dir } });
const get = (qs = '', headers: Record<string, string> = {}) => new Request(`http://localhost/api/brand/logo${qs}`, { headers });

beforeEach(async () => {
  resetLogoCacheForTests();
  dir = await mkdtemp(path.join(tmpdir(), 'crm-logo-route-'));
  await writeFile(path.join(dir, 'brand.svg'), SVG);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const hashOf = async () => (await readLogo('brand.svg', { CRM_ASSETS_DIR: dir }))!.hash;

test('200: тип, защитные заголовки, ETag, тело', async () => {
  const r = await logoResponse(get(), deps());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'image/svg+xml');
  assert.equal(r.headers.get('Content-Length'), String(Buffer.byteLength(SVG)));
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  const csp = r.headers.get('Content-Security-Policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/);
  assert.equal(r.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(r.headers.get('ETag'), `"${await hashOf()}"`);
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(await r.text(), SVG);
});

test('?v равен хешу — immutable; без v или чужой — no-cache', async () => {
  const h = await hashOf();
  assert.equal((await logoResponse(get(`?v=${h}`), deps())).headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await logoResponse(get(), deps())).headers.get('Cache-Control'), 'no-cache');
  assert.equal((await logoResponse(get('?v=other'), deps())).headers.get('Cache-Control'), 'no-cache');
});

test('If-None-Match (и со слабым W/) — 304 без тела', async () => {
  const etag = `"${await hashOf()}"`;
  for (const inm of [etag, `W/${etag}`, `"zzz", ${etag}`]) {
    const r = await logoResponse(get('', { 'If-None-Match': inm }), deps());
    assert.equal(r.status, 304, inm);
    assert.equal(await r.text(), '');
    assert.equal(r.headers.get('ETag'), etag);
  }
  assert.equal((await logoResponse(get('', { 'If-None-Match': '"nope"' }), deps())).status, 200);
});

test('нет настроек или файла — 404 not_found с no-store', async () => {
  for (const d of [deps(null), deps('missing.svg')]) {
    const r = await logoResponse(get(), d);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await r.json(), { error: 'not_found' });
    assert.equal(r.headers.get('Set-Cookie'), null);
  }
});

test('?v с путём на выбор файла не влияет', async () => {
  const r = await logoResponse(get('?v=../../etc/passwd&file=../x.svg'), deps());
  assert.equal(r.status, 200);
  assert.equal(await r.text(), SVG);
});
