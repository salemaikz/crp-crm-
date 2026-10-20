// Манифест изоляции записи: каждый вход описывает существующий маршрут и его метод, маршрутов нет сверх манифеста.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../isolation/manifest/booking';
import { ROOT, walk } from '../../helpers/sourceFiles';

const routeFile = (path: string) => join(ROOT, 'src', 'app', `${path}`, 'route.ts');

const routes = manifest.entries.filter((e) => e.kind === 'route');
const pages = manifest.entries.filter((e) => e.kind === 'page');

test('манифест: 19 маршрутов, каждый — route.ts с экспортом метода и обёрткой route()', () => {
  assert.equal(routes.length, 19);
  for (const e of routes) {
    const file = routeFile(e.path);
    assert.ok(existsSync(file), `нет файла маршрута ${e.method} ${e.path}`);
    const src = readFileSync(file, 'utf8');
    assert.match(src, new RegExp(`export const ${e.method} = route\\(`), `${e.method} ${e.path}`);
    assert.match(src, new RegExp(`perm: '${e.perm}'`), `${e.method} ${e.path}: право`);
  }
});

test('манифест: 2 страницы мастера и «Записей», каждая — page.tsx с обёрткой page()', () => {
  assert.equal(pages.length, 2);
  for (const e of pages) {
    const file = join(ROOT, 'src', 'app', e.path, 'page.tsx');
    assert.ok(existsSync(file), `нет файла страницы ${e.path}`);
    const src = readFileSync(file, 'utf8');
    assert.match(src, /export default page</, e.path);
    assert.match(src, new RegExp(`perm: '${e.perm}'`), `${e.path}: право`);
  }
});

test('маршруты /api/events и /api/bookings все описаны в манифесте', () => {
  const described = new Set(routes.map((e) => `${e.method} ${e.path}`));
  const found: string[] = [];
  for (const f of walk('src/app/api', ['route.ts'])) {
    const m = /^src\/app(\/api\/(?:events|bookings)(?:\/.*)?)\/route\.ts$/.exec(f);
    if (!m) continue;
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const x of src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = route\(/g)) found.push(`${x[1]} ${m[1]}`);
  }
  assert.deepEqual([...found].sort(), [...described].sort());
});
