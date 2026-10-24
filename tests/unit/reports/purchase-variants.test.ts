// Плитки вариантов услуги в форме покупки (A9, D-348): из настроек установки, без архивных. Только синтетика.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { purchaseVariants, tileKey, variantKeyOf } from '../../../src/app/(mgr)/deals/_components/variants';

test('варианты: порядок настроек, архивные услуги и варианты скрыты, нет ключа — пусто', () => {
  const v = purchaseVariants({
    serviceTypes: [
      { key: 'course', label: { ru: 'Курс' }, variants: [{ key: 'a', label: { ru: 'Онлайн' }, amountKzt: 10_000 }, { key: 'b', label: { ru: 'Офлайн' }, amountKzt: 20_000 }, { key: 'x', amountKzt: 1, archived: true }] },
      { key: 'plain', label: { ru: 'Без вариантов' } },
      { key: 'old', label: { ru: 'Старая' }, archived: true, variants: [{ key: 'z', amountKzt: 5 }] },
    ],
  });
  assert.deepEqual(v.map((x) => [x.serviceKey, x.variantKey, x.serviceLabel, x.variantLabel, x.amountKzt]), [
    ['course', 'a', 'Курс', 'Онлайн', 10_000],
    ['course', 'b', 'Курс', 'Офлайн', 20_000],
  ]);
  assert.deepEqual(purchaseVariants(null), []);
  assert.deepEqual(purchaseVariants({}), []);
});

test('локаль покупки: плитка — шаблон с подстановкой, без названий клиента', () => {
  const ru = JSON.parse(readFileSync('messages/ru/deals.json', 'utf8')).purchase;
  assert.match(ru.variantTile, /\{service\}.*\{variant\}.*\{price\}/);
  assert.ok(ru.variantsLabel && ru.otherService);
});

test('variantKeyOf (D-357): ключ выбранной плитки; «Другая услуга» и чужая услуга — без варианта; правка суммы вариант не трогает', () => {
  assert.equal(variantKeyOf(tileKey('course', 'online'), 'course'), 'online');
  // вариант с составным ключом сохраняется целиком
  assert.equal(variantKeyOf(tileKey('course', 'online-2'), 'course'), 'online-2');
  assert.equal(variantKeyOf(null, 'course'), undefined); // «Другая услуга»
  assert.equal(variantKeyOf(tileKey('course', 'online'), 'smm'), undefined); // услугу сменили вручную
  assert.equal(variantKeyOf(tileKey('course', 'online'), ''), undefined);
  assert.equal(variantKeyOf('course/', 'course'), undefined);
});
