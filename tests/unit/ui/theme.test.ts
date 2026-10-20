import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeTheme, deriveBrandRole, parseThemeSettings, themeToCss, DEFAULT_THEME_SETTINGS } from '../../../src/ui/theme/compute';
import { ThemeStyle } from '../../../src/ui/theme/ThemeStyle';
import { contrast, normalizeHex } from '../../../src/ui/theme/color';
import { DENSITY, FONT_PRESETS, NEUTRALS, TAP_MIN } from '../../../src/ui/theme/presets';

const AA = 4.5;

/** Набор цветов бренда: крайние случаи (жёлтый, красный, почти белый/чёрный, серые) и развёртка по кругу. */
function brandSamples(): string[] {
  const out = ['#ffcc00', '#ffff00', '#e31e24', '#ffffff', '#000000', '#808080', '#767676', '#777777', '#00ff00', '#0ff', '#2457c5', '#f8f8f8', '#050505'];
  for (let i = 0; i < 360; i += 7) {
    for (const [s, l] of [[1, 0.5], [0.9, 0.3], [0.6, 0.7], [0.4, 0.45]] as const) {
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((i / 60) % 2) - 1));
      const m = l - c / 2;
      const [r, g, b] = i < 60 ? [c, x, 0] : i < 120 ? [x, c, 0] : i < 180 ? [0, c, x] : i < 240 ? [0, x, c] : i < 300 ? [x, 0, c] : [c, 0, x];
      out.push('#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join(''));
    }
  }
  return out;
}

test('любой бренд: текст на кнопке и бренд-текст на поверхности — не ниже AA', () => {
  for (const color of brandSamples()) {
    const t = computeTheme({ brandColor: color }).vars;
    const at = (name: string) => t[name] as string;
    assert.ok(contrast(at('--on-brand'), at('--brand')) >= AA, `${color}: on-brand/brand`);
    assert.ok(contrast(at('--on-brand'), at('--brand-hover')) >= AA, `${color}: on-brand/hover`);
    assert.ok(contrast(at('--brand-ink'), at('--surface')) >= AA, `${color}: ink/surface`);
    assert.ok(contrast(at('--brand-ink'), at('--canvas')) >= AA, `${color}: ink/canvas`);
    assert.ok(contrast(at('--brand-ink'), at('--brand-tint')) >= AA, `${color}: ink/tint`);
    assert.ok(contrast(at('--ring'), at('--surface')) >= 3, `${color}: ring`);
    assert.ok(contrast(at('--text'), at('--brand-tint')) >= AA, `${color}: text/tint`);
  }
});

test('accentColor считается так же; без него равен бренду', () => {
  const same = computeTheme({ brandColor: '#0b6e4f' }).vars;
  assert.equal(same['--accent'], '#0b6e4f');
  const t = computeTheme({ brandColor: '#0b6e4f', accentColor: '#ffcc00' }).vars;
  assert.equal(t['--accent'], '#ffcc00');
  assert.ok(contrast(t['--on-accent']!, t['--accent']!) >= AA);
  assert.ok(contrast(t['--accent-ink']!, t['--surface']!) >= AA);
});

test('deriveBrandRole: светлый бренд — тёмный текст и светлеющее наведение', () => {
  const r = deriveBrandRole('#ffcc00');
  assert.equal(r.onColor, NEUTRALS.text);
  assert.ok(contrast(r.hover, '#ffffff') < contrast(r.base, '#ffffff'));
  const dark = deriveBrandRole('#10204a');
  assert.equal(dark.onColor, '#ffffff');
});

test('настройки: умолчания, нормализация, разбор мусора по полям', () => {
  assert.deepEqual(parseThemeSettings(undefined).settings, DEFAULT_THEME_SETTINGS);
  assert.deepEqual(parseThemeSettings('x').invalidKeys, []);
  const p = parseThemeSettings({ brandColor: '#ABC', radius: 'xl', density: 'compact', statusStyle: 5, fontPreset: '', accentColor: 'blue', logo: 'any' });
  assert.equal(p.settings.brandColor, '#aabbcc');
  assert.equal(p.settings.radius, 'md');
  assert.equal(p.settings.density, 'compact', 'верное поле сохраняется');
  assert.equal(p.settings.accentColor, null);
  assert.deepEqual(p.invalidKeys.sort(), ['accentColor', 'fontPreset', 'radius', 'statusStyle']);
  assert.ok(computeTheme({ radius: 'xl' }).warnings.includes('invalid-setting'));
});

test('форма и плотность: цели нажатия не меньше 44 px', () => {
  for (const key of Object.keys(DENSITY) as Array<keyof typeof DENSITY>) {
    assert.ok(DENSITY[key].control >= TAP_MIN, key);
    const v = computeTheme({ density: key }).vars;
    assert.ok(parseInt(v['--control-h']!, 10) >= 44);
    assert.equal(v['--tap-min'], '44px');
  }
  const sm = computeTheme({ radius: 'sm' }).vars;
  const lg = computeTheme({ radius: 'lg' }).vars;
  assert.ok(parseInt(sm['--radius-control']!, 10) < parseInt(lg['--radius-control']!, 10));
  assert.ok(parseInt(computeTheme({ density: 'compact' }).vars['--space-row']!, 10) < parseInt(computeTheme({ density: 'normal' }).vars['--space-row']!, 10));
});

test('шрифтовой пресет: известный применяется, неизвестный — системный с предупреждением', () => {
  const known = computeTheme({ fontPreset: 'geologica-onest' });
  assert.equal(known.vars['--font-body'], FONT_PRESETS['geologica-onest']!.body);
  assert.deepEqual(known.warnings, []);
  const unknown = computeTheme({ fontPreset: 'comic' });
  assert.equal(unknown.vars['--font-body'], FONT_PRESETS.system!.body);
  assert.ok(unknown.warnings.includes('unknown-font-preset'));
  for (const [key, p] of Object.entries(FONT_PRESETS)) assert.match(p.body, /sans-serif/, `${key}: запасной стек`);
});

test('statusStyle: значок скрывается только настройкой, предупреждение о «только цвет»', () => {
  assert.equal(computeTheme({}).vars['--status-icon-display'], 'inline-flex');
  const c = computeTheme({ statusStyle: 'color' });
  assert.equal(c.vars['--status-icon-display'], 'none');
  assert.ok(c.warnings.includes('status-color-only'));
});

test('бренд рядом с цветом «опасности» даёт предупреждение; серый и синий — нет', () => {
  assert.ok(computeTheme({ brandColor: '#e31e24' }).warnings.includes('brand-near-danger'));
  assert.ok(!computeTheme({ brandColor: '#2457c5' }).warnings.includes('brand-near-danger'));
  assert.ok(!computeTheme({ brandColor: '#808080' }).warnings.includes('brand-near-danger'));
});

test('themeToCss и ThemeStyle: один блок :root, значения без разметки', () => {
  const css = themeToCss({ '--a': '1', '--b': '2' });
  assert.equal(css, ':root{--a:1;--b:2;}');
  const html = renderToStaticMarkup(createElement(ThemeStyle, { settings: { brandColor: '#0b6e4f', evil: '</style><script>' } }));
  assert.match(html, /^<style id="crm-theme">:root\{/);
  assert.ok(html.includes('--brand:#0b6e4f;'));
  assert.ok(!html.includes('<script>'));
  // ввод <style> в brandColor не проходит проверку hex и не попадает в CSS
  const bad = renderToStaticMarkup(createElement(ThemeStyle, { settings: { brandColor: '#fff;}</style><script>' } }));
  assert.ok(!bad.includes('<script>'));
  assert.equal(normalizeHex(computeTheme({ brandColor: '#fff;}</style>' }).settings.brandColor), DEFAULT_THEME_SETTINGS.brandColor);
});

test('средний тон без читаемого текста сдвигается и помечается; годный — нет', () => {
  const grey = deriveBrandRole('#777777');
  assert.equal(grey.adjusted, true);
  assert.ok(contrast(grey.onColor, grey.base) >= AA);
  assert.ok(computeTheme({ brandColor: '#777777' }).warnings.includes('brand-adjusted'));
  assert.equal(deriveBrandRole('#2457c5').adjusted, false);
  assert.ok(!computeTheme({}).warnings.includes('brand-adjusted'));
});
