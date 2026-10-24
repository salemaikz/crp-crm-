// Тёмная тема (D-342): расчёт, контраст AA относительно поверхности режима, подмена слабого акцента,
// блоки ThemeStyle и выбор вида по cookie. Цвета клиента берутся из настроек, как их отдаёт пресет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeTheme, deriveBrandRoleDark, themeToCssDark } from '../../../src/ui/theme/compute';
import { contrast } from '../../../src/ui/theme/color';
import { NEUTRALS_DARK, STATES_DARK } from '../../../src/ui/theme/presets';
import { ThemeStyle } from '../../../src/ui/theme/ThemeStyle';
import { effectiveMode, htmlThemeAttribute, parseThemeMode, themeAttribute, themeCookieString } from '../../../src/ui/theme/mode';

const AA = 4.5;
const ROOT = join(import.meta.dirname, '..', '..', '..');
const crpTheme = (JSON.parse(readFileSync(join(ROOT, 'presets/clients/crp/preset.json'), 'utf8')) as { global: { theme: Record<string, unknown> } }).global.theme;

const SAMPLES = ['#ffcc00', '#e31e24', '#ffffff', '#000000', '#808080', '#777777', '#0e1726', '#10204a', '#2457c5', '#00ff00', '#050505'];

test('тёмная: любой бренд и акцент — текст на кнопке и бренд-текст на всех поверхностях не ниже AA, заливка ≥ 3:1', () => {
  for (const color of SAMPLES) {
    const v = computeTheme({ brandColor: color, accentColor: color }, 'dark').vars;
    const at = (n: string) => v[n] as string;
    for (const role of ['brand', 'accent']) {
      assert.ok(contrast(at(`--on-${role}`), at(`--${role}`)) >= AA, `${color}: on-${role}`);
      assert.ok(contrast(at(`--on-${role}`), at(`--${role}-hover`)) >= AA, `${color}: on-${role}/hover`);
      assert.ok(contrast(at(`--${role}`), at('--surface')) >= 3, `${color}: ${role}/surface`);
      assert.ok(contrast(at(`--${role}`), at('--canvas')) >= 3, `${color}: ${role}/canvas`);
      assert.ok(contrast(at(`--${role}-ink`), at('--surface')) >= AA, `${color}: ${role}-ink/surface`);
      assert.ok(contrast(at(`--${role}-ink`), at('--canvas')) >= AA, `${color}: ${role}-ink/canvas`);
      assert.ok(contrast(at(`--${role}-ink`), at(`--${role}-tint`)) >= AA, `${color}: ${role}-ink/tint`);
    }
    assert.ok(contrast(at('--ring'), at('--surface')) >= 3, `${color}: ring`);
    assert.ok(contrast(at('--text'), at('--brand-tint')) >= AA, `${color}: text/tint`);
  }
});

test('тёмная: нейтральные и состояния читаются на поверхности, фоне и подложке', () => {
  const v = computeTheme({}, 'dark').vars;
  for (const t of ['--text', '--text-2', '--text-3']) {
    assert.ok(contrast(v[t]!, v['--surface']!) >= AA, t);
    assert.ok(contrast(v[t]!, v['--canvas']!) >= AA, `${t}/canvas`);
  }
  assert.ok(contrast(v['--border-strong']!, v['--surface']!) >= 3);
  for (const k of ['success', 'warning', 'info', 'danger'] as const) {
    assert.equal(v[`--${k}`], STATES_DARK[k].ink);
    for (const bg of ['--surface', '--canvas', `--${k}-tint`]) assert.ok(contrast(v[`--${k}`]!, v[bg]!) >= AA, `${k}/${bg}`);
  }
  assert.equal(v['--canvas'], NEUTRALS_DARK.canvas);
  assert.ok(contrast(v['--on-success']!, v['--success']!) >= AA, 'текст на зелёной кнопке');
  assert.ok(contrast(computeTheme({}).vars['--on-success']!, computeTheme({}).vars['--success']!) >= AA, 'то же на светлой');
});

test('тёмная: тёмные оверлей и тень отличаются от светлых', () => {
  const l = computeTheme({}).vars;
  const d = computeTheme({}, 'dark').vars;
  assert.notEqual(l['--overlay'], d['--overlay']);
  assert.notEqual(l['--shadow-float'], d['--shadow-float']);
  assert.match(d['--overlay']!, /^rgb\(0 0 0/);
});

test('акцент #0e1726 на тёмном фоне заменяется осветлённым оттенком с предупреждением', () => {
  const t = computeTheme({ brandColor: '#e31e24', accentColor: '#0e1726' }, 'dark');
  assert.notEqual(t.vars['--accent'], '#0e1726');
  assert.ok(contrast(t.vars['--accent']!, t.vars['--surface']!) >= 3);
  assert.ok(t.warnings.includes('dark-accent-lightened'));
  assert.ok(!t.warnings.includes('dark-brand-lightened'), 'красный бренд остаётся: 3.5:1');
  assert.equal(t.vars['--brand'], '#e31e24');
  // светлая тема тот же акцент не трогает
  const light = computeTheme({ brandColor: '#e31e24', accentColor: '#0e1726' });
  assert.equal(light.vars['--accent'], '#0e1726');
  assert.ok(!light.warnings.includes('dark-accent-lightened'));
});

test('пресет ЦРП: theme.dark задаёт фон, поверхность и акцент; предупреждений о подмене нет', () => {
  const t = computeTheme(crpTheme, 'dark');
  const dk = crpTheme.dark as { canvas: string; surface: string };
  assert.equal(t.vars['--canvas'], dk.canvas);
  assert.equal(t.vars['--surface'], dk.surface);
  assert.notEqual(t.vars['--canvas'], NEUTRALS_DARK.canvas, 'фон берётся из пресета, а не из умолчания кода');
  assert.notEqual(t.vars['--surface'], NEUTRALS_DARK.surface);
  assert.equal(t.vars['--accent'], '#e8edf7');
  assert.equal(t.vars['--brand'], '#e31e24');
  assert.equal(t.vars['--on-brand'], '#ffffff');
  assert.ok(contrast(t.vars['--on-brand']!, t.vars['--brand']!) >= AA);
  assert.deepEqual(t.warnings.filter((w) => w.startsWith('dark-')), []);
  // светлая тема пресета не меняется от theme.dark
  assert.equal(computeTheme(crpTheme).vars['--canvas'], '#f5f6f8');
});

test('theme.dark: нечитаемая поверхность и мусор отбрасываются, остальное работает', () => {
  const t = computeTheme({ dark: { surface: '#ffffff', canvas: 'red', brandColor: '#2457c5' } }, 'dark');
  assert.ok(t.warnings.includes('dark-surface-invalid'));
  assert.equal(t.vars['--surface'], NEUTRALS_DARK.surface);
  assert.ok(t.invalidKeys.includes('dark.canvas'));
  assert.ok(computeTheme({ dark: 5 }).invalidKeys.includes('dark'));
  assert.equal(computeTheme({ defaultMode: 'sepia' }).settings.defaultMode, null);
});

test('theme.dark: фон, на котором не читается любой нейтральный или тон состояния, отбрасывается', () => {
  // text проходит (≥ 4.5), а text3 и danger на таком фоне — ниже
  const t = computeTheme({ dark: { canvas: '#4a5160' } }, 'dark');
  assert.ok(t.warnings.includes('dark-surface-invalid'));
  assert.equal(t.vars['--canvas'], NEUTRALS_DARK.canvas);
  // читаемый пользовательский фон принимается без предупреждения
  const ok = computeTheme({ dark: { canvas: '#0b0c0e', surface: '#16181c' } }, 'dark');
  assert.ok(!ok.warnings.includes('dark-surface-invalid'));
  assert.equal(ok.vars['--canvas'], '#0b0c0e');
  for (const k of ['text', 'text-2', 'text-3', 'danger', 'warning', 'info', 'success']) {
    assert.ok(contrast(ok.vars[`--${k}`]!, ok.vars['--canvas']!) >= AA, k);
    assert.ok(contrast(ok.vars[`--${k}`]!, ok.vars['--surface']!) >= AA, `${k}/surface`);
  }
});

test('deriveBrandRoleDark: светлый бренд остаётся, тёмный осветляется', () => {
  assert.equal(deriveBrandRoleDark('#ffcc00', NEUTRALS_DARK.canvas, NEUTRALS_DARK.surface).adjusted, false);
  assert.equal(deriveBrandRoleDark('#10204a', NEUTRALS_DARK.canvas, NEUTRALS_DARK.surface).adjusted, true);
});

test('ThemeStyle: без флага только светлая, с флагом — тёмный блок и медиазапрос', () => {
  const off = renderToStaticMarkup(createElement(ThemeStyle, { settings: crpTheme }));
  assert.ok(!off.includes('data-theme'));
  assert.ok(!off.includes('prefers-color-scheme'));
  assert.ok(!off.includes('color-scheme'));
  const on = renderToStaticMarkup(createElement(ThemeStyle, { settings: crpTheme, darkEnabled: true }));
  assert.ok(on.includes(':root[data-theme="dark"]{color-scheme:dark;'));
  assert.ok(on.includes('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;'));
  // тёмный блок содержит только отличия: форма и шрифты не повторяются
  assert.ok(!/data-theme="dark"\]\{[^}]*--radius-card/.test(on));
  assert.ok(/data-theme="dark"\]\{[^}]*--canvas:#0d1424;/.test(on));
  assert.ok(on.startsWith('<style id="crm-theme">:root{'));
});

test('themeToCssDark: только отличающиеся переменные', () => {
  const css = themeToCssDark({ '--a': '1', '--b': '2' }, { '--a': '1', '--b': '3' }, ':root[data-theme="dark"]');
  assert.equal(css, ':root[data-theme="dark"]{color-scheme:dark;--b:3;}');
});

test('вид интерфейса: cookie → вид по умолчанию → система; флаг выключен — всегда светлая', () => {
  assert.equal(effectiveMode('dark', null, true), 'dark');
  assert.equal(effectiveMode(undefined, null, true), 'system');
  assert.equal(effectiveMode(undefined, 'light', true), 'light');
  assert.equal(effectiveMode('мусор', 'dark', true), 'dark');
  assert.equal(effectiveMode('dark', 'dark', false), 'light');
  assert.equal(parseThemeMode('Dark'), null);
  assert.equal(htmlThemeAttribute('dark', null, false), undefined, 'флаг выключен — атрибута нет');
  assert.equal(htmlThemeAttribute(undefined, null, true), undefined);
  assert.equal(htmlThemeAttribute('light', 'dark', true), 'light');
  assert.equal(themeAttribute('system'), undefined);
  assert.equal(themeAttribute('dark'), 'dark');
  const c = themeCookieString('dark');
  assert.match(c, /^crm_theme=dark; Path=\/; Max-Age=31536000; SameSite=Lax$/);
  assert.ok(!/HttpOnly/i.test(c));
});

test('оболочка: переключатель выводится только по данным loadThemeSwitch, а он зависит от флага THEME_DARK', () => {
  const load = readFileSync(join(ROOT, 'src/ui/theme/loadSwitch.ts'), 'utf8');
  assert.match(load, /isFeatureEnabled\('THEME_DARK'\)\) return null/);
  assert.match(readFileSync(join(ROOT, 'src/ui/shells/RoleShell.tsx'), 'utf8'), /themeSwitch=\{themeSwitch\}/);
  assert.match(readFileSync(join(ROOT, 'src/app/layout.tsx'), 'utf8'), /isFeatureEnabled\('THEME_DARK'\)/);
  const shell = JSON.parse(readFileSync(join(ROOT, 'messages/ru/shell.json'), 'utf8')) as { theme: Record<string, string> };
  assert.deepEqual(Object.keys(shell.theme).sort(), ['dark', 'label', 'light', 'system']);
});

test('плашка логотипа: в тёмной теме по умолчанию есть, theme.dark.logoPlate=false убирает; в светлой её нет', () => {
  const plate = (settings: Record<string, unknown>, variant: 'light' | 'dark') => computeTheme(settings, variant).vars['--logo-plate'];
  assert.notEqual(plate({}, 'dark'), 'transparent');
  assert.equal(plate({ dark: { logoPlate: false } }, 'dark'), 'transparent');
  assert.equal(computeTheme({ dark: { logoPlate: false } }, 'dark').vars['--logo-pad'], '0px');
  assert.equal(plate({}, 'light'), 'transparent');
  assert.equal(plate({ dark: { logoPlate: true } }, 'light'), 'transparent');
  const bad = computeTheme({ dark: { logoPlate: 'no' } }, 'dark');
  assert.notEqual(bad.vars['--logo-plate'], 'transparent');
  assert.ok(bad.warnings.includes('invalid-setting'));
});

test('пресет ЦРП: логотип с прозрачным фоном стоит в тёмной теме без плашки', () => {
  assert.equal(computeTheme(crpTheme, 'dark').vars['--logo-plate'], 'transparent');
});
