// Полоса лицензии в оболочке D-319 (P10b, D-327): своё место под шапкой на линиях --gutter, над Page, касание ≥ 44 px.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { ShellBanner } from '../../../src/ui/shells/ShellBanner';
import type { BannerView } from '../../../src/ui/shells/LicenseBannerBar';

const h = createElement as unknown as (type: unknown, props?: object | null, ...children: unknown[]) => ReactElement;
const ROOT = join(import.meta.dirname, '..', '..', '..');
const view = (p: Partial<BannerView> = {}): BannerView => ({ tone: 'warn', text: 'Срок лицензии скоро закончится', dismissible: true, dismissLabel: 'Свернуть', ...p });

test('нет баннера — нет и обёртки (страница начинается своим отступом Page)', () => {
  assert.equal(render(h(ShellBanner, { banner: null, side: true })), '');
});

test('баннер стоит на линиях страницы: --gutter по бокам, --page-top сверху, ширина не больше широкой страницы', () => {
  const html = render(h(ShellBanner, { banner: view(), side: false }));
  assert.match(html, /data-testid="shell-banner" class="px-\[var\(--gutter\)\] pt-\[var\(--page-top\)\]"/);
  assert.match(html, /max-w-\[var\(--page-w-wide\)\]/);
  assert.match(html, /data-testid="license-banner" data-tone="warn"/);
  // свой нижний отступ не нужен: зазор до заголовка даёт верхний отступ Page
  assert.doesNotMatch(html, /\bm[bt]-\d/);
  assert.doesNotMatch(html, /md:ms-0/, 'в нижней оболочке колонка по центру');
});

test('в боковой оболочке баннер прижат влево, как Page (левый край на одной линии с заголовком)', () => {
  assert.match(render(h(ShellBanner, { banner: view(), side: true })), /md:ms-0/);
});

test('кнопка «Свернуть» — зона касания 44 px; без права свернуть кнопки нет', () => {
  assert.match(render(h(ShellBanner, { banner: view(), side: true })), /<button type="button" aria-label="Свернуть" class="[^"]*min-h-11 min-w-11/);
  assert.doesNotMatch(render(h(ShellBanner, { banner: view({ dismissible: false }), side: true })), /<button/);
});

test('AppShell: полоса — первая в области страницы, у области нет своих отступов (их задаёт Page)', () => {
  const src = readFileSync(join(ROOT, 'src/ui/shells/AppShell.tsx'), 'utf8');
  const area = /<div className="min-w-0 flex-1">\s*<ShellBanner banner=\{banner\} side=\{side\} \/>\s*\{children\}\s*(?:\{boardTip \? <BoardTipSpacer userId=\{userId\} \/> : null\}\s*)?<\/div>/;
  assert.match(src, area);
  assert.doesNotMatch(src, /LicenseBannerBar banner=/, 'полоса рисуется только через ShellBanner');
});
