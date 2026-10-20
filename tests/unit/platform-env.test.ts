import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDbConfigured, databaseUrl, isProduction, migrateDatabaseUrl, readEnv } from '../../src/server/platform/env';

test('production без DATABASE_URL падает', () => {
  assert.throws(() => assertDbConfigured({ NODE_ENV: 'production' }), /DATABASE_URL is not set in production/);
  assert.throws(() => assertDbConfigured({ NODE_ENV: 'production', DATABASE_URL: '   ' }), /production/);
});

test('вне production без DATABASE_URL тоже падает: встроенной БД нет', () => {
  assert.throws(() => databaseUrl({ NODE_ENV: 'development' }), /DATABASE_URL is not set/);
  assert.throws(() => databaseUrl({}), /DATABASE_URL is not set/);
});

test('DATABASE_URL читается без пробелов', () => {
  assert.equal(databaseUrl({ DATABASE_URL: ' postgres://u@h/db ' }), 'postgres://u@h/db');
  assert.equal(readEnv({ A: '' }, 'A'), undefined);
});

test('миграции идут под MIGRATE_DATABASE_URL, иначе под DATABASE_URL', () => {
  assert.equal(migrateDatabaseUrl({ DATABASE_URL: 'postgres://app@h/db', MIGRATE_DATABASE_URL: 'postgres://owner@h/db' }), 'postgres://owner@h/db');
  assert.equal(migrateDatabaseUrl({ DATABASE_URL: 'postgres://app@h/db' }), 'postgres://app@h/db');
  assert.throws(() => migrateDatabaseUrl({}), /DATABASE_URL/);
});

test('isProduction', () => {
  assert.equal(isProduction({ NODE_ENV: 'production' }), true);
  assert.equal(isProduction({ NODE_ENV: 'test' }), false);
});
