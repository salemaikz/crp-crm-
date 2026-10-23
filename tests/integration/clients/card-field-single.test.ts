// Ввод одного поля на месте (pipeline-v2 §9.6): тело без `version` с ровно одним ключом сверяется только по `expect`,
// версия карточки растёт. Устаревшая версия (итог в очереди устройства) на такую правку не влияет.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldConflictError, FieldIssuesError, updateCardFields, type PatchCardBody } from '../../../src/server/domain/clients';
import { NotFoundError } from '../../../src/server/access';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, cardOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const one = (key: string, value: unknown, prev: unknown): PatchCardBody => ({ set: { custom: { [key]: value } }, expect: { custom: { [key]: prev } } });

test('одно поле без version при верном expect — 200, версия растёт даже после другой правки карточки', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 30);
  // карточка уже изменилась другой правкой: версия 1 вместо той, что видел интерфейс
  await updateCardFields(v, id, { version: 0, set: { custom: { plan: 'один' } }, expect: { custom: { plan: null } } });
  const r = await updateCardFields(v, id, one('plan', 'два', 'один'));
  assert.equal(r.version, 2);
  assert.equal(r.fields.values.plan, 'два');
  const [row] = await db.sql<{ custom: Record<string, unknown>; version: number }>`SELECT custom, version FROM cards WHERE id = ${id}`;
  assert.equal(row?.custom.plan, 'два');
  assert.equal(row?.version, 2);
});

test('одно поле без version при неверном expect — 409 с текущим значением, ничего не пишется', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 31);
  await updateCardFields(v, id, one('plan', 'один', null));
  await assert.rejects(
    () => updateCardFields(v, id, one('plan', 'три', 'не то')),
    (e: unknown) => e instanceof FieldConflictError && e.key === 'plan' && e.current === 'один' && e.detail === 'card_changed',
  );
  const [row] = await db.sql<{ custom: Record<string, unknown>; version: number }>`SELECT custom, version FROM cards WHERE id = ${id}`;
  assert.equal(row?.custom.plan, 'один');
  assert.equal(row?.version, 1);
});

test('поле только для чтения без version — 400 с ключом, не 409', async () => {
  const v = await viewerOf(U.opA);
  await assert.rejects(
    () => updateCardFields(v, cardOf('a', 32), one('budget', 100, null)),
    (e: unknown) => e instanceof FieldIssuesError && e.issues.some((i) => i.key === 'budget'),
  );
});

test('чужая карточка без version — 404 как несуществующая', async () => {
  const v = await viewerOf(U.opA);
  await assert.rejects(() => updateCardFields(v, cardOf('b', 30), one('plan', 'х', null)), NotFoundError);
  await assert.rejects(() => updateCardFields(v, 'cd-нет-такой', one('plan', 'х', null)), NotFoundError);
});
