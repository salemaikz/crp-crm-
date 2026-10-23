import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, isFeatureEnabled } from '../../src/server/platform/flags';

test('список флагов совпадает с CONFIG §7', () => {
  assert.deepEqual(
    [...FEATURES].sort(),
    ['BK_WIZARD', 'BULK_TRANSFER', 'CALLBACK_V2', 'IMPORT', 'IMPORT_BOOKINGS', 'KANBAN', 'MERGE', 'OP_BOARD', 'PURCHASES', 'PUSH', 'REPORTS', 'REPORTS_EXPORT', 'SALES_SETTINGS', 'TELEPHONY_BEELINE', 'TELEPHONY_ZADARMA', 'THEME_DARK', 'WAZZUP'],
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

test('флаги воронки v2 (pipeline-v2 §8.3): в бою без явного 1 выключены, мусор — выключен', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const f of ['CALLBACK_V2', 'OP_BOARD', 'THEME_DARK'] as const) {
      assert.equal(isFeatureEnabled(f, { NODE_ENV: 'production' }), false, f);
      assert.equal(isFeatureEnabled(f, {}), false, f);
      assert.equal(isFeatureEnabled(f, { NODE_ENV: 'production', [`FEATURE_${f}`]: 'on' }), false, f);
      assert.equal(isFeatureEnabled(f, { NODE_ENV: 'development', [`FEATURE_${f}`]: 'true' }), false, f);
      assert.equal(isFeatureEnabled(f, { NODE_ENV: 'production', [`FEATURE_${f}`]: '1' }), true, f);
      assert.equal(isFeatureEnabled(f, { NODE_ENV: 'development', [`FEATURE_${f}`]: '0' }), false, f);
    }
  } finally {
    console.warn = warn;
  }
});
