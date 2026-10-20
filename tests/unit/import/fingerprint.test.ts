// Отпечаток предпросмотра (D-113): порядок ключей карты не важен; меняется от сборки, ревизии, карты,
// решения одной строки.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { imports } from '@crm/core';
import { canonicalJson, previewFingerprint, type FingerprintInput } from '../../../src/server/domain/import/fingerprint';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const row = (n: number, o: Partial<imports.PreviewRow> = {}): imports.PreviewRow => ({
  rowNo: n,
  action: 'create',
  hold: '',
  holds: [],
  ownerUserId: 'u1',
  ownerKind: 'assigned',
  matchId: null,
  pairs: [],
  outcomeKey: null,
  agreedWithoutBooking: false,
  stoppedPhones: 0,
  issues: [],
  noteFlags: [],
  ...o,
});
const base = (): FingerprintInput => ({
  buildId: 'b1',
  configRev: { global: 1, space: 2 },
  importId: 'imp',
  fileSha256: 'f'.repeat(64),
  profileKey: 'p',
  snapshotDay: '2026-10-20',
  ownerMap: { A: 'u1', B: 'u2' },
  rows: [row(3), row(4, { action: 'merge', matchId: 'cl9' })],
});
const fp = (o: Partial<FingerprintInput> = {}) => previewFingerprint({ ...base(), ...o }, sha);

test('отпечаток: 64 hex, стабилен', () => {
  assert.match(fp(), /^[0-9a-f]{64}$/);
  assert.equal(fp(), fp());
});

test('отпечаток: порядок ключей карты не важен, пустые значения карты не влияют', () => {
  assert.equal(fp({ ownerMap: { B: 'u2', A: 'u1' } }), fp());
  assert.equal(fp({ ownerMap: { A: 'u1', B: 'u2', C: undefined } }), fp());
});

test('отпечаток: меняется от сборки, ревизии, файла, дня, карты', () => {
  const ref = fp();
  assert.notEqual(fp({ buildId: 'b2' }), ref);
  assert.notEqual(fp({ configRev: { global: 1, space: 3 } }), ref);
  assert.notEqual(fp({ fileSha256: 'e'.repeat(64) }), ref);
  assert.notEqual(fp({ snapshotDay: '2026-10-21' }), ref);
  assert.notEqual(fp({ ownerMap: { A: 'u1', B: 'u3' } }), ref);
});

test('отпечаток: меняется от решения одной строки', () => {
  const ref = fp();
  assert.notEqual(fp({ rows: [row(3), row(4, { action: 'create' })] }), ref);
  assert.notEqual(fp({ rows: [row(3, { hold: 'rule' }), row(4, { action: 'merge', matchId: 'cl9' })] }), ref);
  assert.notEqual(fp({ rows: [row(3, { ownerUserId: 'u2' }), row(4, { action: 'merge', matchId: 'cl9' })] }), ref);
  assert.notEqual(fp({ rows: [row(3), row(4, { action: 'merge', matchId: 'cl8' })] }), ref);
  assert.notEqual(fp({ rows: [row(3, { pairs: [{ id: 'x', reason: 'shared_phone' }] }), row(4, { action: 'merge', matchId: 'cl9' })] }), ref);
  assert.notEqual(fp({ rows: [row(3, { stoppedPhones: 1 }), row(4, { action: 'merge', matchId: 'cl9' })] }), ref);
  assert.notEqual(fp({ rows: [row(3, { agreedWithoutBooking: true }), row(4, { action: 'merge', matchId: 'cl9' })] }), ref);
  assert.notEqual(fp({ rows: [row(3, { outcomeKey: 'agreed' }), row(4, { action: 'merge', matchId: 'cl9' })] }), ref);
});

test('отпечаток: замечания и отметки заметки (не решение) не влияют', () => {
  assert.equal(fp({ rows: [row(3, { issues: ['x'], noteFlags: ['y'] }), row(4, { action: 'merge', matchId: 'cl9' })] }), fp());
});

test('canonicalJson: вложенные объекты сортируются, undefined пропускается', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } }), '{"a":{"c":null,"d":[2,{"z":1}]},"b":1}');
});
