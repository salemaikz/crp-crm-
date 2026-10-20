// Сведение платформы: тема, шрифты, обёртки маршрутов входа — статические проверки исходников.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk } from '../helpers/sourceFiles';
import { computeTheme } from '../../src/ui/theme';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('globals.css подключает токены и стили кита; корневой layout — тема и тосты', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /@import '\.\.\/ui\/tokens\.css'/);
  assert.match(css, /@import '\.\.\/ui\/kit\/kit\.css'/);
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /<ThemeStyle settings=\{config\?\.global\.theme\} nonce=\{nonce\}/);
  assert.match(layout, /<ToastProvider>/);
  assert.match(read('src/ui/index.ts'), /export \* from '\.\/kit'/);
});

test('пресет geologica_onest из настроек известен теме; запасной стек остаётся', () => {
  const t = computeTheme({ fontPreset: 'geologica_onest' });
  assert.ok(!t.warnings.includes('unknown-font-preset'));
  assert.match(t.vars['--font-body'] ?? '', /var\(--font-onest, /);
});

test('шрифты локальные: файлы на месте, обращений к Google нет', () => {
  const fonts = read('src/app/fonts.ts');
  for (const m of fonts.matchAll(/public\/fonts\/([a-z-]+\.woff2)/g)) {
    assert.ok(existsSync(join(ROOT, 'public/fonts', m[1]!)), m[1]);
  }
  for (const f of [...walk('src', ['.ts', '.tsx', '.css']), 'next.config.ts']) {
    assert.ok(!/fonts\.(googleapis|gstatic)\.com|next\/font\/google/.test(read(f)), f);
  }
});

test('маршруты входа на обёртках доступа; локального _lib нет', () => {
  assert.ok(!existsSync(join(ROOT, 'src/app/api/auth/_lib.ts')));
  const routes = walk('src/app/api/auth', ['route.ts']);
  assert.ok(routes.length >= 6, routes.join());
  for (const f of routes) {
    const text = read(f);
    assert.match(text, /export const POST = (publicRoute|route)\(/, f);
    assert.match(text, /from '@\/server\/access'/, f);
    assert.ok(!/checkOrigin|export async function POST/.test(text), `${f}: Origin проверяет обёртка`);
  }
  // мутации безопасности помечены (D-054)
  assert.match(read('src/app/api/auth/logout-all/route.ts'), /securityMutation: 'auth\.logout_all'/);
  assert.match(read('src/app/api/auth/password/route.ts'), /securityMutation: 'auth\.change_own_password'/);
});

test('значения ядра берутся из корня @crm/core (D-101): подпути только для типов', () => {
  for (const f of walk('src', ['.ts', '.tsx'])) {
    for (const m of read(f).matchAll(/^import\s+(?!type\b)(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+'@crm\/core\/[^']+'/gm)) {
      assert.fail(`${f}: значение из подпути ядра: ${m[0]}`);
    }
  }
});
