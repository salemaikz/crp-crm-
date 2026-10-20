// Слой БД на Postgres 16: транзакции с SAVEPOINT, jsonb, camelCase, BIGINT как number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUniqueViolation } from '../../../src/server/platform/db/core';
import { createTestDb } from '../../../src/server/platform/db/testing';

test('строки в camelCase, BIGINT — number, jsonb читается объектом', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, created_at BIGINT NOT NULL, custom_data JSONB NOT NULL)');
    await db.sql`INSERT INTO t (id, space_id, created_at, custom_data) VALUES ('1', 's', ${1_760_000_000_000}, ${db.json({ snake_key: [1, 2] })})`;
    const [row] = await db.sql<{ id: string; spaceId: string; createdAt: number; customData: { snake_key: number[] } }>`SELECT * FROM t`;
    assert.deepEqual(row, { id: '1', spaceId: 's', createdAt: 1_760_000_000_000, customData: { snake_key: [1, 2] } });
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
  } finally {
    await db.close();
  }
});

test('вложенный tx — SAVEPOINT: пойманная ошибка откатывает только вложенную часть', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await db.exec('CREATE TABLE u (id TEXT PRIMARY KEY)');
    await db.tx(async (sql) => {
      await sql`INSERT INTO u (id) VALUES ('a')`;
      await assert.rejects(
        db.tx(async (inner) => {
          await inner`INSERT INTO u (id) VALUES ('b')`;
          await inner`INSERT INTO u (id) VALUES ('a')`;
        }),
        (e: unknown) => isUniqueViolation(e),
      );
      await sql`INSERT INTO u (id) VALUES ('c')`;
    });
    const ids = (await db.sql<{ id: string }>`SELECT id FROM u ORDER BY id`).map((r) => r.id);
    assert.deepEqual(ids, ['a', 'c']);
  } finally {
    await db.close();
  }
});

test('ошибка во внешней транзакции откатывает всё', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await db.exec('CREATE TABLE v (id TEXT PRIMARY KEY)');
    await assert.rejects(
      db.tx(async (sql) => {
        await sql`INSERT INTO v (id) VALUES ('a')`;
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal((await db.sql`SELECT id FROM v`).length, 0);
  } finally {
    await db.close();
  }
});

test('запрос через db.sql внутри db.tx идёт в ту же транзакцию', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await db.exec('CREATE TABLE w (id TEXT PRIMARY KEY)');
    await assert.rejects(
      db.tx(async () => {
        await db.sql`INSERT INTO w (id) VALUES ('a')`;
        throw new Error('boom');
      }),
    );
    assert.equal((await db.sql`SELECT id FROM w`).length, 0);
  } finally {
    await db.close();
  }
});

test('тестовая схема удаляется при close()', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  const [s] = await db.sql<{ s: string }>`SELECT current_schema() AS s`;
  assert.match(s?.s ?? '', /^test_[0-9a-f]{16}$/);
  await db.close();
  const admin = await createTestDb({ migrate: false, register: false });
  try {
    const left = await admin.sql<{ n: string }>`SELECT nspname AS n FROM pg_namespace WHERE nspname = ${s?.s ?? ''}`;
    assert.equal(left.length, 0);
  } finally {
    await admin.close();
  }
});
