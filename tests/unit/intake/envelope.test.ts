// Конверт партии: ошибки — пути и коды без значений; лишние поля записи игнорируются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../../../src/server/domain/intake/envelope';
import { isClosedFromOutside } from '../../../src/server/domain/intake/gate';

const ID = '3b0f6c1e-6a52-4c0e-9b8a-2f1d7c9e4a10';

test('корректная партия; null и лишние поля допустимы', () => {
  const r = parseEnvelope({ batchId: ID, items: [{ name: 'ТОО', extra: 1, region: null, phones: null }] }, 1000);
  assert.ok(r.ok);
});

test('ошибки: пути и коды, значений нет', () => {
  const issues = (body: unknown, max = 3) => {
    const r = parseEnvelope(body, max);
    assert.ok(!r.ok);
    return r.issues.map((i) => `${i.path}:${i.code}`).sort();
  };
  assert.deepEqual(issues(null), [':invalid_type']);
  assert.deepEqual(issues({}), ['batchId:required', 'items:required']);
  assert.deepEqual(issues({ batchId: 'x', items: [] }), ['batchId:invalid_format', 'items:too_few']);
  assert.deepEqual(issues({ batchId: ID, items: [{}, {}, {}, {}] }), ['items:too_many']);
  assert.deepEqual(issues({ batchId: ID, items: [{ name: 'x'.repeat(501), phones: ['1'.repeat(41)], kind: 'org' }] }), ['items.0.kind:invalid_value', 'items.0.name:too_long', 'items.0.phones.0:too_long']);
  assert.deepEqual(issues({ batchId: ID, items: [{ phones: 'строка' }, 5] }), ['items.0.phones:invalid_type', 'items.1:invalid_type']);
  const r = parseEnvelope({ batchId: ID, items: [{ name: 'СЕКРЕТНОЕ'.repeat(100) }] }, 3);
  assert.ok(!r.ok && !JSON.stringify(r.issues).includes('СЕКРЕТНОЕ'));
});

test('закрытие снаружи: открывает только INGEST_PUBLIC=1; без заголовка прокси запрос внутренний', () => {
  const via = { get: (n: string) => (n === 'x-via-proxy' ? '1' : null) };
  const direct = { get: () => null };
  assert.equal(isClosedFromOutside(via, {}), true);
  assert.equal(isClosedFromOutside(via, { INGEST_PUBLIC: '0' }), true);
  assert.equal(isClosedFromOutside(via, { INGEST_PUBLIC: 'yes' }), true);
  assert.equal(isClosedFromOutside(via, { INGEST_PUBLIC: '1' }), false);
  assert.equal(isClosedFromOutside(direct, {}), false);
  assert.equal(isClosedFromOutside(direct, { INGEST_PUBLIC: '0' }), false);
});
