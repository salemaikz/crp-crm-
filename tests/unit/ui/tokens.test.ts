import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTheme } from '../../../src/ui/theme/compute';
import { contrast } from '../../../src/ui/theme/color';
import { NEUTRALS, STATES } from '../../../src/ui/theme/presets';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const tokensCss = readFileSync(join(ROOT, 'src/ui/tokens.css'), 'utf8');
const kitCss = readFileSync(join(ROOT, 'src/ui/kit/kit.css'), 'utf8');

/** Переменные из первого блока :root tokens.css. */
function rootVars(css: string): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

test('tokens.css: умолчания совпадают с computeTheme({}) — без расхождения', () => {
  const declared = rootVars(tokensCss);
  const computed = computeTheme({}).vars;
  for (const [name, value] of Object.entries(computed)) assert.equal(declared.get(name), value, name);
});

test('kit.css использует только объявленные токены', () => {
  const declared = new Set(rootVars(tokensCss).keys());
  // локальные переменные компонентов объявляются в самом kit.css
  for (const m of kitCss.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]!);
  const used = new Set([...kitCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!));
  const missing = [...used].filter((n) => !declared.has(n));
  assert.deepEqual(missing, []);
});

test('Tailwind @theme ссылается на существующие переменные', () => {
  const declared = new Set(rootVars(tokensCss).keys());
  const theme = /@theme inline\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? '';
  assert.ok(theme.length > 0);
  for (const m of theme.matchAll(/--[\w-]+\s*:\s*var\((--[\w-]+)\)/g)) {
    if (m[1] === undefined) continue;
    assert.ok(declared.has(m[1]), m[1]);
  }
});

test('в токенах нет значений бренда клиента: умолчание нейтральное', () => {
  assert.ok(!/#e31e24/i.test(tokensCss));
});

test('нейтральные: текст читается на поверхности и подложке (AA), рамка полей ≥ 3:1', () => {
  for (const key of ['text', 'text2', 'text3'] as const) {
    assert.ok(contrast(NEUTRALS[key], NEUTRALS.surface) >= 4.5, `${key}/surface`);
    assert.ok(contrast(NEUTRALS[key], NEUTRALS.canvas) >= 4.5, `${key}/canvas`);
  }
  assert.ok(contrast(NEUTRALS.borderStrong, NEUTRALS.surface) >= 3);
});

test('состояния: цвет читается как текст на поверхности и на своей подложке (AA)', () => {
  for (const [key, s] of Object.entries(STATES)) {
    assert.ok(contrast(s.ink, NEUTRALS.surface) >= 4.5, `${key}/surface`);
    assert.ok(contrast(s.ink, s.tint) >= 4.5, `${key}/tint`);
    assert.ok(contrast(s.ink, NEUTRALS.canvas) >= 4.5, `${key}/canvas`);
  }
});

test('тост: белый текст на тёмной подложке — AA', () => {
  assert.ok(contrast('#ffffff', NEUTRALS.text) >= 4.5);
});
