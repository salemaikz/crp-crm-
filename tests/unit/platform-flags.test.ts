import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, isFeatureEnabled } from '../../src/server/platform/flags';

test('список флагов совпадает с CONFIG §7', () => {
  assert.deepEqual(
    [...FEATURES].sort(),
    ['BK_WIZARD', 'BULK_TRANSFER', 'IMPORT', 'KANBAN', 'MERGE', 'PURCHASES', 'PUSH', 'REPORTS_EXPORT', 'TELEPHONY_BEELINE', 'TELEPHONY_ZADARMA', 'WAZZUP'],
  );
});

test('явные 1 и 0 решают всё', () => {
  assert.equal(isFeatureEnabled('KANBAN', { NODE_ENV: 'production', FEATURE_KANBAN: '1' }), true);
  assert.equal(isFeatureEnabled('KANBAN', { NODE_ENV: 'development', FEATURE_KANBAN: '0' }), false);
});

test('не задан: включён только в development и test; пустое окружение и production — выключен', () => {
  assert.equal(isFeatureEnabled('PUSH', { NODE_ENV: 'development' }), true);
  assert.equal(isFeatureEnabled('PUSH', { NODE_ENV: 'test', FEATURE_PUSH: '' }), true);
  assert.equal(isFeatureEnabled('PUSH', { NODE_ENV: 'production' }), false);
  assert.equal(isFeatureEnabled('PUSH', {}), false);
  assert.equal(isFeatureEnabled('PUSH', { NODE_ENV: 'staging' }), false);
  assert.equal(isFeatureEnabled('WAZZUP', { FEATURE_WAZZUP: '' }), false);
});

test('мусорное значение — выключено, даже вне production', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(isFeatureEnabled('MERGE', { NODE_ENV: 'development', FEATURE_MERGE: 'yes' }), false);
  } finally {
    console.warn = warn;
  }
});
