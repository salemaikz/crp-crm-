// Манифест уведомлений описывает существующие входы с той же обёрткой и правом; маршрутов /api/notify сверх манифеста нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../isolation/manifest/notify';
import { ROOT, walk } from '../../helpers/sourceFiles';

test('маршруты — route.ts с экспортом метода, обёрткой route() и правом authenticated', () => {
  const routes = manifest.entries.filter((e) => e.kind === 'route');
  assert.equal(routes.length, 2);
  for (const e of routes) {
    const file = join(ROOT, 'src', 'app', e.path, 'route.ts');
    assert.ok(existsSync(file), `нет файла ${e.method} ${e.path}`);
    const src = readFileSync(file, 'utf8');
    assert.match(src, new RegExp(`export const ${e.method} = route\\(`));
    assert.match(src, /perm: 'authenticated'/);
  }
});

test('страница колокольчика защищена page() с правом authenticated', () => {
  const pages = manifest.entries.filter((e) => e.kind === 'page');
  assert.equal(pages.length, 1);
  const src = readFileSync(join(ROOT, 'src', 'app', '(op)', 'notifications', 'page.tsx'), 'utf8');
  assert.match(src, /page<[^>]*>\(\{ perm: 'authenticated' \}/);
});

test('все маршруты /api/notify описаны в манифесте', () => {
  const described = new Set(manifest.entries.filter((e) => e.kind === 'route').map((e) => `${e.method} ${e.path}`));
  const found: string[] = [];
  for (const f of walk('src/app/api', ['route.ts'])) {
    const m = /^src\/app(\/api\/notify(?:\/.*)?)\/route\.ts$/.exec(f);
    if (!m) continue;
    for (const x of readFileSync(join(ROOT, f), 'utf8').matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = route\(/g)) found.push(`${x[1]} ${m[1]}`);
  }
  assert.deepEqual(found.sort(), [...described].sort());
});
