// 409 при правке поля клиента на месте (pipeline-v2 §9.6, D-356): тело несёт `current` только по ключам запроса
// и только видимым зрителю; скрытое роли поле — без значения (как раньше, 400 по ключу); чужой клиент — 404.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientFieldConflictError, FieldIssuesError, updateClient, type PatchBody } from '../../../src/server/domain/clients';
import { NotFoundError } from '../../../src/server/access';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const body = (set: PatchBody['set'], expect: PatchBody['expect']): PatchBody => ({ set, expect });

test('409 по полю настроек несёт текущее значение именно этого ключа', async () => {
  const id = clientOf('a', 40);
  const v = await viewerOf(U.opA);
  await updateClient(v, id, body({ system: {}, custom: { segment: 'малый' } }, { system: {}, custom: { segment: null } }));
  await assert.rejects(
    () => updateClient(v, id, body({ system: {}, custom: { segment: 'мой' } }, { system: {}, custom: { segment: 'устарело' } })),
    (e: unknown) =>
      e instanceof ClientFieldConflictError && e.code === 'conflict' && e.detail === 'client_changed' && e.current.custom.segment === 'малый' && Object.keys(e.current.custom).length === 1 && Object.keys(e.current.system).length === 0,
  );
  const [row] = await db.sql<{ custom: Record<string, unknown> }>`SELECT custom FROM clients WHERE id = ${id}`;
  assert.equal(row?.custom.segment, 'малый');
});

test('409 по системному полю несёт его текущее значение', async () => {
  const id = clientOf('a', 41);
  const v = await viewerOf(U.opA);
  await updateClient(v, id, body({ system: { region: 'Астана' }, custom: {} }, { system: { region: '' }, custom: {} }));
  await assert.rejects(
    () => updateClient(v, id, body({ system: { region: 'Алматы' }, custom: {} }, { system: { region: 'Шымкент' }, custom: {} })),
    (e: unknown) => e instanceof ClientFieldConflictError && e.current.system.region === 'Астана' && Object.keys(e.current.custom).length === 0,
  );
});

test('поле, скрытое роли, — без значения: ошибка поля, а не 409 с текущим', async () => {
  const id = clientOf('a', 42);
  const rop = await viewerOf(U.rop);
  await updateClient(rop, id, body({ system: {}, custom: { credit: 500000 } }, { system: {}, custom: { credit: null } }));
  const op = await viewerOf(U.opA);
  await assert.rejects(
    () => updateClient(op, id, body({ system: {}, custom: { secret: 'мой' } }, { system: {}, custom: { secret: 'угадал' } })),
    (e: unknown) => e instanceof FieldIssuesError && !('current' in e),
  );
  // поле только для чтения оператору: тоже не 409 с чужим значением
  await assert.rejects(
    () => updateClient(op, id, body({ system: {}, custom: { credit: 1 } }, { system: {}, custom: { credit: 7 } })),
    (e: unknown) => e instanceof FieldIssuesError && !('current' in e),
  );
});

test('чужой клиент и несуществующий — один и тот же 404', async () => {
  const op = await viewerOf(U.opA);
  const b = body({ system: {}, custom: { segment: 'х' } }, { system: {}, custom: { segment: 'у' } });
  await assert.rejects(() => updateClient(op, clientOf('b', 40), b), NotFoundError);
  await assert.rejects(() => updateClient(op, 'cl-нет-такого', b), NotFoundError);
});
