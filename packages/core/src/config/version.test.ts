import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CONFIG_SCHEMA_VERSION, ConfigVersionError, migrateDoc } from './version.js';
import type { ConfigMigration } from './migrations/index.js';
import { lastPresetDoc, nextRev, pickCompatible, type RevisionSource } from './revisions.js';
import { assertJson, canonicalJson, configHash, deepEqual } from './json.js';
import type { Json } from './json.js';

test('версия схемы v1', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 1);
});

test('migrateDoc: цепочка vN → vN+1, глобальный и пространственный вид, вход не мутируется', () => {
  const ms: ConfigMigration[] = [
    { from: 1, to: 2, global: (d) => ({ ...d, g2: true }), space: (d) => ({ ...d, s2: true }) },
    { from: 2, to: 3, global: (d) => ({ ...d, g3: true }), space: (d) => ({ ...d, s3: true }) },
  ];
  const doc = { a: 1 };
  assert.deepEqual(migrateDoc('global', doc, 1, 3, ms), { a: 1, g2: true, g3: true });
  assert.deepEqual(migrateDoc('space', doc, 2, 3, ms), { a: 1, s3: true });
  assert.deepEqual(migrateDoc('space', doc, 3, 3, ms), { a: 1 });
  assert.deepEqual(doc, { a: 1 });
  assert.throws(() => migrateDoc('global', doc, 1, 4, ms), /нет миграции настроек v3 → v4/);
  assert.throws(() => migrateDoc('global', doc, 4, 3, ms), ConfigVersionError);
  assert.throws(() => migrateDoc('global', doc, 0, 3, ms), ConfigVersionError);
});

type R = { rev: number; schemaVersion: number; source: RevisionSource; presetDoc: Json | null };

test('pickCompatible: последняя ревизия со schema_version ≤ поддерживаемой (D-060)', () => {
  const revs: R[] = [
    { rev: 1, schemaVersion: 1, source: 'preset', presetDoc: { p: 1 } },
    { rev: 2, schemaVersion: 1, source: 'ui', presetDoc: null },
    { rev: 3, schemaVersion: 2, source: 'migration', presetDoc: null },
    { rev: 4, schemaVersion: 2, source: 'preset', presetDoc: { p: 2 } },
  ];
  assert.equal(pickCompatible(revs, 1)?.rev, 2);
  assert.equal(pickCompatible(revs, 2)?.rev, 4);
  assert.equal(pickCompatible(revs, 0), undefined);
  assert.equal(pickCompatible([], 1), undefined);
  // номер новой ревизии — по всем версиям: после отката прежняя версия пишет rev 5, а не 3
  assert.equal(nextRev(revs), 5);
  assert.equal(nextRev([]), 1);
  assert.deepEqual(lastPresetDoc(revs, 1), { p: 1 });
  assert.deepEqual(lastPresetDoc(revs, 2), { p: 2 });
  assert.equal(lastPresetDoc(revs.slice(1, 3), 2), undefined);
});

test('canonicalJson: ключи по алфавиту на всех уровнях, массивы по порядку', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY));
});

test('configHash = sha256 канонического JSON, 64 hex (как CHECK в config_revisions)', async () => {
  const doc = { b: 'тест', a: [1, 2.5, true, null] };
  const h = await configHash(doc);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex'));
  assert.equal(await configHash({ a: [1, 2.5, true, null], b: 'тест' }), h);
  assert.notEqual(await configHash({ ...doc, c: 1 }), h);
});

test('deepEqual и assertJson', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: [1, 2] }, { a: [2, 1] }));
  assert.ok(!deepEqual({ a: undefined }, {}));
  assert.throws(() => assertJson({ a: new Date() }));
  assert.throws(() => assertJson({ a: () => 1 }));
  assert.throws(() => assertJson({ a: undefined }));
});
