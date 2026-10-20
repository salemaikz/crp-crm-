import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TIME_ZONE, resolveTimeZone } from '../../src/i18n/config';

test('пояс берётся из настроек; пустой или неверный — запасной', () => {
  assert.equal(resolveTimeZone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(resolveTimeZone(null), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone('  '), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone('Not/AZone'), DEFAULT_TIME_ZONE);
});
