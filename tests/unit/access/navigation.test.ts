// Переход документа на адрес API (D-310): route() отвечает 404 без данных и не читает сессию; fetch страницы и
// маршруты скачивания из закрытого списка работают. Список сверяется с файлами маршрутов в обе стороны.
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

register('../../isolation/runner/hooks.mjs', import.meta.url);

const { route } = await import('../../../src/server/access/wrappers');
const { overrideViewer } = await import('../../../src/server/access/current');
const { resetAccessForTests, testViewer } = await import('../../../src/server/access/testing');
const { DOWNLOAD_ROUTES, isDocumentNavigation, isDownloadRoute } = await import('../../../src/server/access/navigation');

afterEach(() => resetAccessForTests());

const ORIGIN = 'http://crm.test';
const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const FETCH = { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };
const ctx = { params: Promise.resolve({ id: 'x' }) };

test('признак перехода документа: navigate, nested-navigate, document/iframe/embed/object; fetch и без заголовков — нет', () => {
  const h = (x: Record<string, string>) => isDocumentNavigation(new Headers(x));
  assert.equal(h(NAVIGATE), true);
  assert.equal(h({ 'sec-fetch-mode': 'navigate' }), true);
  assert.equal(h({ 'sec-fetch-mode': 'nested-navigate', 'sec-fetch-dest': 'iframe' }), true);
  for (const dest of ['document', 'iframe', 'frame', 'embed', 'object']) assert.equal(h({ 'sec-fetch-dest': dest }), true, dest);
  assert.equal(h(FETCH), false);
  assert.equal(h({ 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }), false);
  assert.equal(h({}), false, 'запрос не из браузера (тесты, curl) — не переход');
});

test('route(): GET /api/* переходом документа — 404 без данных, сессия не читается; fetch — как обычно', async () => {
  let viewerReads = 0;
  overrideViewer(async () => {
    viewerReads++;
    return testViewer({ userId: 'u-op', role: null, license: 'valid', spaceId: null });
  });
  const h = route({ perm: 'authenticated' }, async () => ({ names: ['ТОО Синтетика №1'] }));
  const variants: Record<string, string>[] = [NAVIGATE, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-mode': 'navigate' }];
  for (const headers of variants) {
    const res = await h(new Request(`${ORIGIN}/api/calls/queue?limit=4`, { headers }), ctx);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'not_found' });
    assert.ok(!text.includes('Синтетика'));
  }
  const head = await h(new Request(`${ORIGIN}/api/clients/x`, { method: 'HEAD', headers: NAVIGATE }), ctx);
  assert.equal(head.status, 404);
  assert.equal(viewerReads, 0, 'до сессии дело не дошло');
  const ok = await h(new Request(`${ORIGIN}/api/calls/queue?limit=4`, { headers: FETCH }), ctx);
  assert.equal(ok.status, 200);
  assert.equal(viewerReads, 1);
});

test('route(): маршрут скачивания из списка открывается переходом (ссылка download)', async () => {
  overrideViewer(async () => testViewer({ userId: 'u-mgr', role: null, license: 'valid', spaceId: null }));
  const h = route({ perm: 'authenticated' }, async () => new Response('a;b\n', { headers: { 'Content-Disposition': 'attachment; filename="x.csv"' } }));
  const res = await h(new Request(`${ORIGIN}/api/import/imp-1/rows.csv?filter=all`, { headers: NAVIGATE }), ctx);
  assert.equal(res.status, 200);
  assert.equal(isDownloadRoute('/api/import/imp-1/rows.csv'), true);
  assert.equal(isDownloadRoute('/api/import//rows.csv'), false, 'пустой сегмент — не id');
  assert.equal(isDownloadRoute('/api/import/imp-1/rows'), false);
  assert.equal(isDownloadRoute('/api/import/imp-1/rows.csv/x'), false);
});

const APP = join(import.meta.dirname, '..', '..', '..', 'src', 'app');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

/** '/api/import/[id]/rows.csv' из пути файла: группы `(x)` в URL не входят. */
const urlOf = (file: string) =>
  '/' +
  relative(APP, file)
    .split(sep)
    .slice(0, -1)
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))
    .join('/');

test('список скачиваний = GET-маршруты, отдающие файл (Content-Disposition): в обе стороны', () => {
  const downloads = routeFiles(join(APP, 'api'))
    .filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /export const GET\b/.test(text) && /Content-Disposition/i.test(text);
    })
    .map(urlOf)
    .sort();
  assert.deepEqual([...DOWNLOAD_ROUTES].sort(), downloads);
});
