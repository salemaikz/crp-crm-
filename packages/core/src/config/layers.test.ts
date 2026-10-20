import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleLayers, checkLayerChain, parseLayer, PresetLayerError, satisfiesProduct, type PresetLayer } from './layers.js';
import { validateConfigSet } from './validate.js';
import { minimalGlobal, minimalSpace } from './testing/minimal.js';
import { ConfigVersionError } from './version.js';

const meta = (key: string, ext: string[] = [], extra: Record<string, unknown> = {}) => ({ key, version: '2026.10.1', schemaVersion: 1, extends: ext, ...extra });
const layer = (raw: Record<string, unknown>): PresetLayer => parseLayer(raw);
const V = { productVersion: '1.0.0' };

test('base + страновой + отраслевой + клиент собираются и проходят схему', () => {
  const base = layer({ meta: meta('base'), global: minimalGlobal(), spaceDefaults: minimalSpace() });
  const country = layer({
    meta: meta('kz', ['base']),
    global: { org: { timezone: 'Asia/Almaty', idRule: 'kz_bin' }, calendar: { holidays: [{ date: '2026-03-08', kind: 'holiday', note: '' }] } },
  });
  const industry = layer({
    meta: meta('consulting-sales', ['base', 'kz']),
    spaceDefaults: {
      booking: {
        directions: [{ key: 'other', label: { ru: 'Другое' } }],
        eventTypes: [{ key: 'group_session', behavior: 'group', label: { ru: 'Группа' }, short: { ru: 'Г' }, capacity: 30, durationMin: 180, directions: [] }],
      },
    },
  });
  const client = layer({
    meta: meta('acme', ['base', 'kz', 'consulting-sales'], { requires: { product: '>=1.0.0' } }),
    global: { org: { productName: { ru: 'CRM Acme' } }, calendar: { holidays: [{ date: '2026-12-31', kind: 'holiday', note: 'corp' }] } },
    spaces: { sales: { distribution: { mode: 'auto_even', dailyCap: 40 }, calling: { callbackPresets: ['+2h', 'nextEvent:group_session@10:00'] } } },
  });
  const a = assembleLayers([base, country, industry, client], V);
  assert.deepEqual(a.layers.map((l) => l.key), ['base', 'kz', 'consulting-sales', 'acme']);
  assert.deepEqual(Object.keys(a.spaces), ['sales']);
  const r = validateConfigSet({ global: a.global, spaces: a.spaces });
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues));
  const v = r.value;
  assert.equal(v.global.org.timezone, 'Asia/Almaty');
  assert.equal(v.global.org.productName.ru, 'CRM Acme');
  assert.deepEqual(v.global.calendar.holidays.map((h) => h.date), ['2026-01-01', '2026-03-08', '2026-12-31']);
  assert.equal(v.spaces.sales?.distribution.mode, 'auto_even');
  assert.equal(v.spaces.sales?.booking.eventTypes[0]?.key, 'group_session');
});

test('spaceDefaults слоя выше перекрывает spaces.K слоя ниже; spaces.K того же слоя — сильнее его spaceDefaults', () => {
  const base = layer({ meta: meta('base'), global: { spaces: [{ key: 'sales' }] }, spaces: { sales: { cap: 1 } }, spaceDefaults: { cap: 0, mode: 'a' } });
  const top = layer({ meta: meta('top', ['base']), spaceDefaults: { cap: 2 } });
  assert.deepEqual(assembleLayers([base, top], V).spaces.sales, { cap: 2, mode: 'a' });
  const same = layer({ meta: meta('same', ['base']), spaceDefaults: { cap: 3 }, spaces: { sales: { cap: 4 } } });
  assert.deepEqual(assembleLayers([base, same], V).spaces.sales, { cap: 4, mode: 'a' });
});

test('цепочка слоёв: порядок extends, повторы, первый слой, версия продукта', () => {
  const b = layer({ meta: meta('base') });
  const k = layer({ meta: meta('kz', ['base']) });
  const c = layer({ meta: meta('client', ['base', 'kz']) });
  checkLayerChain([b, k, c], '1.0.0');
  checkLayerChain([b, k, layer({ meta: meta('client', ['base']) })], '1.0.0'); // подпоследовательность
  assert.throws(() => checkLayerChain([b, c, k], '1.0.0'), PresetLayerError);
  assert.throws(() => checkLayerChain([k], '1.0.0'), PresetLayerError);
  assert.throws(() => checkLayerChain([b, b], '1.0.0'), PresetLayerError);
  assert.throws(() => checkLayerChain([b, layer({ meta: meta('client', ['kz', 'base']) })], '1.0.0'), PresetLayerError);
  const needs2 = layer({ meta: meta('client', ['base'], { requires: { product: '>=2.0.0' } }) });
  assert.throws(() => checkLayerChain([b, needs2], '1.9.9'), /требует продукт/);
  checkLayerChain([b, needs2], '2.0.0');
  assert.throws(() => checkLayerChain([], '1.0.0'), PresetLayerError);
});

test('parseLayer: форма слоя строгая, __proto__ и не-JSON отклоняются', () => {
  assert.throws(() => parseLayer({ meta: meta('base'), extra: {} }), PresetLayerError);
  assert.throws(() => parseLayer({ meta: { key: 'Base', version: '1', schemaVersion: 1 } }), PresetLayerError);
  assert.throws(() => parseLayer({ meta: meta('base'), spaces: { Sales: {} } }), PresetLayerError);
  assert.throws(() => parseLayer(JSON.parse('{"meta":{"key":"base","version":"1.0.0","schemaVersion":1},"global":{"__proto__":{}}}')), PresetLayerError);
  assert.throws(() => parseLayer({ meta: meta('base'), global: { x: Number.NaN } }), PresetLayerError);
});

test('слой новее схемы сборки не собирается', () => {
  const b = layer({ meta: { ...meta('base'), schemaVersion: 2 }, global: {} });
  assert.throws(() => assembleLayers([b], V), ConfigVersionError);
});

test('satisfiesProduct', () => {
  assert.ok(satisfiesProduct('>=1.0.0', '1.0.0'));
  assert.ok(satisfiesProduct('>=1.0.0', 'v1.2.0-rc.1'));
  assert.ok(satisfiesProduct('>=1.2.3', '1.10.0'));
  assert.ok(!satisfiesProduct('>=1.2.3', '1.2.2'));
  assert.ok(!satisfiesProduct('^1.0.0', '1.0.0'));
  assert.ok(!satisfiesProduct('>=1.0.0', 'dev'));
});
