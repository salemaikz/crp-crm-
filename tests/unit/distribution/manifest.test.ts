// Манифест изоляции раздачи: каждый вход описывает существующий маршрут (или страницу) с той же обёрткой и правом;
// маршрутов /api/distribution сверх манифеста нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../../isolation/manifest/distribution';
import { ROOT, walk } from '../../helpers/sourceFiles';

const routeFile = (path: string) => join(ROOT, 'src', 'app', path, 'route.ts');

test('манифест: маршруты — route.ts с экспортом метода, обёрткой route() и тем же правом', () => {
  const routes = manifest.entries.filter((e) => e.kind === 'route');
  assert.equal(routes.length, 16);
  for (const e of routes) {
    const file = routeFile(e.path);
    assert.ok(existsSync(file), `нет файла маршрута ${e.method} ${e.path}`);
    const src = readFileSync(file, 'utf8');
    assert.match(src, new RegExp(`export const ${e.method} = route\\(`), `${e.method} ${e.path}`);
    assert.match(src, new RegExp(`perm: '${e.perm}'`), `${e.method} ${e.path}: право`);
  }
});

test('экраны РОП (раздача, спорные пары) описаны и защищены page() с правом pool.read', () => {
  const pages = manifest.entries.filter((e) => e.kind === 'page');
  assert.deepEqual(pages.map((p) => p.path).sort(), ['/(mgr)/distribution', '/(mgr)/pairs']);
  for (const dir of ['distribution', 'pairs']) {
    const file = join(ROOT, 'src', 'app', '(mgr)', dir, 'page.tsx');
    assert.ok(existsSync(file), dir);
    assert.match(readFileSync(file, 'utf8'), /page<[^>]*>\(\{ perm: 'pool\.read' \}/, dir);
  }
});

test('маршруты /api/distribution все описаны в манифесте', () => {
  const described = new Set(manifest.entries.filter((e) => e.kind === 'route').map((e) => `${e.method} ${e.path}`));
  const found: string[] = [];
  for (const f of walk('src/app/api', ['route.ts'])) {
    const m = /^src\/app(\/api\/distribution(?:\/.*)?)\/route\.ts$/.exec(f);
    if (!m) continue;
    for (const x of readFileSync(join(ROOT, f), 'utf8').matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = route\(/g)) found.push(`${x[1]} ${m[1]}`);
  }
  assert.deepEqual(found.sort(), [...described].sort());
});
