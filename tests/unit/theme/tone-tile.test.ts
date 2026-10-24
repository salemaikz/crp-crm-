// Заливки плиток тонов доски (ui-polish §9.4): токены --{tone}-tile считает тема, а не компонент.
// Проверки на базовой теме, тёмной теме продукта и теме пресета клиента (светлая и тёмная).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeTheme, deriveToneTile } from '../../../src/ui/theme/compute';
import { contrast } from '../../../src/ui/theme/color';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const TONES = ['success', 'warning', 'info', 'danger'] as const;

function presetThemes(): Array<[string, unknown]> {
  const dir = join(ROOT, 'presets/clients');
  return readdirSync(dir).map((name) => [name, (JSON.parse(readFileSync(join(dir, name, 'preset.json'), 'utf8')) as { global: { theme: unknown } }).global.theme]);
}

const CASES: Array<[string, unknown]> = [['база', {}], ...presetThemes()];

for (const [name, raw] of CASES) {
  for (const variant of ['light', 'dark'] as const) {
    test(`плитка тона: ${name}, ${variant} — текст ≥ 4.5, полоса ≥ 3, плитка к поверхности ≥ 1.2`, () => {
      const t = computeTheme(raw, variant);
      const v = t.vars;
      for (const k of TONES) {
        const tile = v[`--${k}-tile`]!;
        assert.match(tile, /^#[0-9a-f]{6}$/, `${k}: токен есть`);
        assert.ok(contrast(v['--text']!, tile) >= 4.5, `${k}: text`);
        assert.ok(contrast(v['--text-2']!, tile) >= 4.5, `${k}: text-2`);
        assert.ok(contrast(v[`--${k}`]!, tile) >= 3, `${k}: полоса`);
        assert.ok(contrast(tile, v['--surface']!) >= 1.2, `${k}: отличие от поверхности`);
      }
      assert.ok(!t.warnings.includes('tone-tile-adjusted'), 'предупреждения о заливках нет');
    });
  }
}

test('плитка тона: жёлтая остаётся жёлтой — красный канал заметно выше синего в обеих темах', () => {
  for (const variant of ['light', 'dark'] as const) {
    const tile = computeTheme({}, variant).vars['--warning-tile']!;
    const [r, , b] = [1, 3, 5].map((i) => parseInt(tile.slice(i, i + 2), 16));
    assert.ok(r! - b! >= 40, `${variant}: ${tile}`);
  }
});

test('плитка тона: если проверки не проходят ни при какой доле, остаётся стартовая и ok=false', () => {
  // Поверхность и текст одного цвета: контраст текста невозможен
  const r = deriveToneTile('success', '#808080', '#808080', '#808080', '#808080', false);
  assert.equal(r.ok, false);
});

test('плитка тона: доля подстраивается, когда стартовая не проходит', () => {
  // Тёмная поверхность, текст слабее обычного: при стартовой доле 0.26 текст ниже 4.5, меньшая доля проходит
  const r = deriveToneTile('warning', '#1b1d21', '#a2a7b0', '#a2a7b0', '#f0b04a', true);
  assert.ok(r.ok);
  assert.ok(r.alpha < 0.26, 'доля уменьшена');
  assert.ok(contrast('#a2a7b0', r.tile) >= 4.5);
});
