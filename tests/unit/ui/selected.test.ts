// Выбранное нейтрально (D-358 п. 3): рамка --text, фон --surface-selected, без accent и danger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTheme } from '../../../src/ui/theme/compute';
import { contrast } from '../../../src/ui/theme/color';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const kitCss = readFileSync(join(ROOT, 'src/ui/kit/kit.css'), 'utf8');
const tokensCss = readFileSync(join(ROOT, 'src/ui/tokens.css'), 'utf8');

/** Тела правил, чей селектор содержит выбранное состояние. */
function selectedBlocks(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of kitCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    if (/aria-(pressed|selected)='true'|aria-current='page'/.test(selector) && !/:focus-visible/.test(selector)) out.push({ selector, body: m[2]! });
  }
  return out;
}

test('у выбранного нет --accent* и --danger*', () => {
  const blocks = selectedBlocks();
  assert.ok(blocks.length >= 2);
  for (const b of blocks) assert.ok(!/--(accent|danger)/.test(b.body), b.selector);
});

test('выбранное: рамка --text 2px и фон --surface-selected', () => {
  const chip = selectedBlocks().find((b) => b.selector.includes('.k-chip[aria-pressed'));
  assert.ok(chip);
  assert.match(chip.body, /var\(--text\)/);
  assert.match(chip.body, /var\(--surface-selected\)/);
  assert.match(chip.body, /2px/);
});

test('токены: --board-col 17rem, --board-col-end 15rem, --nav-h, --surface-selected', () => {
  assert.match(tokensCss, /--board-col:\s*17rem/);
  assert.match(tokensCss, /--board-col-end:\s*15rem/);
  assert.match(tokensCss, /--nav-h:/);
  assert.match(tokensCss, /--surface-selected:/);
});

test('контраст рамки выбранного >= 3:1 к фону и поверхности в обеих темах', () => {
  for (const variant of ['light', 'dark'] as const) {
    const v = computeTheme({}, variant).vars;
    for (const bg of ['--surface-selected', '--surface', '--canvas']) {
      assert.ok(contrast(v['--text']!, v[bg]!) >= 3, `${variant} ${bg}`);
    }
    assert.ok(contrast(v['--text']!, v['--surface-selected']!) >= 4.5, `${variant} текст на выбранном`);
  }
});

test('кнопка success и подвал шторки: только безопасная зона, без отступа под меню (модальная шторка его перекрывает)', () => {
  assert.match(kitCss, /\.k-btn--success\s*\{/);
  assert.match(kitCss, /\.k-overlay--sheet \.k-overlay__footer\s*\{[^}]*safe-area-inset-bottom/s);
  assert.doesNotMatch(kitCss, /\.k-overlay__footer[^{]*\{[^}]*--nav-h/s);
});

test('вкладка колонки: активная — жирный --text, полоса 3px снизу и --surface-selected; неактивная — --text-2', () => {
  const active = selectedBlocks().find((b) => b.selector.includes('.k-tab['));
  assert.ok(active, 'правило активной вкладки');
  assert.match(active.body, /font-weight:\s*(700|800)/);
  assert.match(active.body, /var\(--text\)/);
  assert.match(active.body, /var\(--surface-selected\)/);
  assert.match(active.body, /border-bottom-color:\s*var\(--text\)/);
  const base = /\.k-tab\s*\{([^}]*)\}/.exec(kitCss)?.[1] ?? '';
  assert.match(base, /color:\s*var\(--text-2\)/);
  assert.match(base, /border-bottom:\s*3px solid transparent/);
});
