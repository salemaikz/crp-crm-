import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, ensureContrast, hue, hueDistance, isHex, luminance, meetsAA, mix, normalizeHex, parseHex, readableOn, toHex } from '../../../src/ui/theme/color';

test('hex: разбор, нормализация, неверный ввод', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('#1A2b3C'), [26, 43, 60]);
  assert.equal(parseHex('red'), null);
  assert.equal(parseHex('#12345'), null);
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(toHex([300, -5, 7.4]), '#ff0007');
  assert.equal(isHex('#12345g'), false);
  assert.equal(isHex(42), false);
  assert.throws(() => luminance('oops'));
});

test('контраст: эталонные значения WCAG', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  // #767676 на белом — классическая граница AA (4.54)
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
  assert.ok(meetsAA('#767676', '#ffffff'));
  assert.ok(!meetsAA('#777777', '#ffffff'));
  assert.ok(meetsAA('#777777', '#ffffff', 3));
  assert.equal(contrast('#123456', '#fedcba'), contrast('#fedcba', '#123456'));
});

test('mix: края и середина', () => {
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#102030', '#ffffff', 5), '#ffffff', 't ограничивается 0..1');
});

test('readableOn выбирает лучший по контрасту', () => {
  assert.equal(readableOn('#ffffff', ['#000000', '#ffffff']), '#000000');
  assert.equal(readableOn('#101010', ['#000000', '#ffffff']), '#ffffff');
});

test('ensureContrast: затемняет до порога и не трогает годный цвет', () => {
  assert.equal(ensureContrast('#2457C5', ['#ffffff']), '#2457c5');
  const fixed = ensureContrast('#ffcc00', ['#ffffff', '#f5f6f8']);
  assert.ok(contrast(fixed, '#ffffff') >= 4.5 && contrast(fixed, '#f5f6f8') >= 4.5);
  assert.equal(ensureContrast('#ffffff', ['#ffffff'], 21), '#000000');
});

test('тон и расстояние между тонами', () => {
  assert.equal(hue('#ff0000'), 0);
  assert.equal(hue('#00ff00'), 120);
  assert.equal(hue('#0000ff'), 240);
  assert.equal(hue('#808080'), 0);
  assert.equal(hueDistance(358, 2), 4);
  assert.equal(hueDistance(10, 200), 170);
});
