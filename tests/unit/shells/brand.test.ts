// brandView и BrandMark (D-333): варианты brandMark, запасное имя, разметка без next/image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { brandView } from '../../../src/ui/shells/brandView';
import { BrandMark } from '../../../src/ui/shells/BrandMark';

const file = { bytes: Buffer.from('x'), contentType: 'image/svg+xml', hash: 'abc123' };
const cfg = (theme: Record<string, unknown>, name: string | null = 'Синтетик CRM') => ({
  global: { org: { productName: name === null ? {} : { ru: name } }, theme: { logo: 'brand.svg', ...theme } },
});
const found = async (key: string) => (key === 'brand.svg' ? file : null);
const none = async () => null;

test('нет brandMark, name, logo без файла — logoSrc null', async () => {
  assert.deepEqual(await brandView(cfg({}), 'Запас', found), { name: 'Синтетик CRM', logoSrc: null });
  assert.equal((await brandView(cfg({ brandMark: 'name' }), 'Запас', found)).logoSrc, null);
  assert.equal((await brandView(cfg({ brandMark: 'logo' }), 'Запас', none)).logoSrc, null);
  assert.equal((await brandView(null, 'Запас', found)).logoSrc, null);
});

test('logo с файлом — адрес с хешем', async () => {
  assert.equal((await brandView(cfg({ brandMark: 'logo' }), 'Запас', found)).logoSrc, '/api/brand/logo?v=abc123');
});

test('имя: productName.ru, запасное — из локали', async () => {
  assert.equal((await brandView(cfg({}, '  Имя  '), 'Запас', found)).name, 'Имя');
  assert.equal((await brandView(cfg({}, null), 'Запас', found)).name, 'Запас');
  assert.equal((await brandView(null, 'Запас', found)).name, 'Запас');
});

test('BrandMark: текстовый режим — strong с shell-brand', () => {
  const html = renderToStaticMarkup(createElement(BrandMark, { name: 'Синтетик CRM', logoSrc: null, size: 'bar' }));
  assert.match(html, /<strong[^>]*data-testid="shell-brand"[^>]*>Синтетик CRM<\/strong>/);
  assert.ok(!html.includes('<img'));
});

test('BrandMark: логотип — img с alt, фиксированной высотой и без перекраски', () => {
  for (const [size, h] of [['bar', 28], ['auth', 40]] as const) {
    const html = renderToStaticMarkup(createElement(BrandMark, { name: 'Синтетик CRM', logoSrc: '/api/brand/logo?v=abc123', size }));
    assert.match(html, /data-testid="shell-brand"/);
    assert.match(html, /<img /);
    assert.match(html, /alt="Синтетик CRM"/);
    assert.match(html, /src="\/api\/brand\/logo\?v=abc123"/);
    assert.ok(html.includes(`height:${h}px`), html);
    assert.ok(html.includes('width:auto'));
    assert.ok(html.includes('object-fit:contain'));
    assert.ok(!/srcset|_next\/image|filter|mix-blend/i.test(html));
  }
});

test('BrandMark: боковое меню — 28 px на любой ширине', () => {
  const html = renderToStaticMarkup(createElement(BrandMark, { name: 'Синтетик CRM', logoSrc: '/api/brand/logo?v=abc123', size: 'side' }));
  assert.ok(html.includes('height:28px'), html);
  assert.ok(!html.includes('md:h-8'), html);
  const bar = renderToStaticMarkup(createElement(BrandMark, { name: 'Синтетик CRM', logoSrc: '/api/brand/logo?v=abc123', size: 'bar' }));
  assert.ok(!bar.includes('md:h-8'), bar);
});
