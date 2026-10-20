import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TIME_ZONE, resolveTimeZone } from '../../src/i18n/config';

test('пояс берётся из настроек; нет настроек — запасной', () => {
  assert.equal(resolveTimeZone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(resolveTimeZone('Asia/Almaty'), 'Asia/Almaty');
  assert.equal(resolveTimeZone(null), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(undefined), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone('  '), DEFAULT_TIME_ZONE);
});

test('неверный пояс — ошибка, а не тихий UTC', () => {
  assert.throws(() => resolveTimeZone('Not/AZone'), /неизвестный часовой пояс/);
  assert.throws(() => resolveTimeZone('Астана'), /неизвестный часовой пояс/);
});
