/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API и строки БД в тестах читаются по путям */
// Строка поиска клиентов из приёма (D-123, ревью дня 2 п. 7): та же функция, что у правки в карточке.
// Мир — синтетика клиентов (роли ЦРП, поле `secret` скрыто от оператора) + источник приёма.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '@crm/core/config';
import { listClients, parseListQuery } from '../../../src/server/domain/clients';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld, worldConfig } from '../clients/world';
import { batch, mkKey, post } from './helpers';

let db: TestDb;
let key: string;

before(async () => {
  db = await openClientsWorld();
  const docs = worldConfig();
  const g = docs.global as Record<string, any>;
  g.org.personIdRule = 'kz_iin_hmac';
  // segment виден всем, secret скрыт от оператора; оба принимаются из источника
  g.fields = (g.fields as JsonObject[]).map((f) => (f.key === 'segment' || f.key === 'secret' ? { ...f, ingest: true } : f));
  g.sources = [
    ...g.sources,
    { key: 'site', label: { ru: 'Сайт' }, kind: 'ingest', allowPersonNames: false, detailedReport: true, rejectRules: [], holdRules: [] },
  ];
  resetConfigCache();
  await writeConfig({ docs, source: 'cli', authorId: null, project: true, note: 'приём в мире клиентов' });
  key = (await mkKey('site')).key;
});
after(() => closeClientsWorld(db));

const find = async (user: string, s: string) => (await listClients(await viewerOf(user), parseListQuery(new URLSearchParams({ q: s })))).items.map((i) => i.id);

test('поиск по значению скрытого поля ничего не находит; по названию, БИН и видимому полю — находит', async () => {
  const res = await post(key, batch([{ name: 'ТОО «Ырыс Сауда»', orgId: '123412341234', phones: ['+7 709 444 12 12'], custom: { segment: 'Розница', secret: 'тайноеслово' } }]));
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).items[0].status, 'created');
  const [c] = await db.sql<any>`SELECT id, search_norm, custom FROM clients WHERE name = 'ТОО «Ырыс Сауда»'`;
  assert.equal(c.custom.secret, 'тайноеслово', 'значение сохранено — скрыто только из поиска');
  assert.equal(c.searchNorm, 'тоо ырыс сауда | 123412341234 | 77094441212 | розница');
  // карточка — оператору A: теперь клиент в его охвате
  await db.sql`UPDATE cards SET owner_user_id = ${U.opA} WHERE client_id = ${c.id}`;
  assert.deepEqual(await find(U.opA, 'тайноеслово'), []);
  assert.deepEqual(await find(U.rop, 'тайноеслово'), [], 'поле скрыто хоть одной роли — в общий поиск не входит');
  assert.deepEqual(await find(U.opA, 'Ырыс'), [c.id]);
  assert.deepEqual(await find(U.opA, '123412341234'), [c.id]);
  assert.deepEqual(await find(U.opA, 'розница'), [c.id]);
});
