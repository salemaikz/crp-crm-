/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД в тестах читаются по путям */
// Кэш горячести новой карточки из приёма (pipeline-v2 §5.4): heat = heatOf(...) сразу после вставки, а не 0.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { calling } from '@crm/core';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { loadBoardSettings } from '../../../src/server/domain/cards/boardSettings';
import { batch, intakeDocs, mkKey, ph, post, spaceIdOf, digitsOf } from './helpers';

let db: TestDb;
let open: string;

before(async () => {
  db = await createTestDb();
  resetConfigCache();
  const docs = intakeDocs();
  (docs.spaces['sales'] as any).queue.heat = {
    states: { callback: 100, new: 20, retry: 0 },
    reasons: {},
    flags: { attendedGroup: 200, attendedIndividual: 300, noShow: 100, purchased: 250, lprYes: 50 },
  };
  await writeConfig({ docs, source: 'cli', authorId: null, project: true, note: 'heat test' });
  open = (await mkKey('open')).key;
});
after(async () => {
  await db.close();
});

test('карточка из ingest: heat = heatOf(новая) по весам пространства, а не 0', async () => {
  const res = await post(open, batch([{ externalId: 'h-1', name: 'ТОО Горячий Лид', phones: [ph(50)] }]));
  assert.equal(res.status, 200);
  const [c] = await db.sql<any>`SELECT c.heat, c.state FROM cards c JOIN client_phones p ON p.client_id = c.client_id WHERE p.digits = ${digitsOf(50)}`;
  const w = (await loadBoardSettings(await spaceIdOf(db))).heat;
  const expected = calling.heatOf(
    { state: 'new', callbackReason: '', lpr: 'unknown', attendedGroupAt: null, attendedIndividualAt: null, lastNoShowAt: null, purchasesTotal: 0, nextCallAt: null, nextCallPrecision: 'time' } as any,
    w,
  );
  assert.equal(c.state, 'new');
  assert.equal(expected, 20);
  assert.equal(c.heat, expected);
});
