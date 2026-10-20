// Поиск по списку (4.5, D-123): название с формой собственности и без, казахские буквы, номер с 8 и +7,
// БИН, скрытое поле не находится, лимит, охват, фильтры полей.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { listClients, parseListQuery, updateClient } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, clientOf, phoneOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
  const rop = await viewerOf(U.rop);
  await updateClient(rop, clientOf('a', 70), {
    set: { system: { name: 'ТОО «Қазына Ай»', org_id: '987654321098' }, custom: { segment: 'Оптовая торговля', industry: 'trade', tags: ['vip'] } },
    expect: { system: { name: 'ТОО Синтетика Альфа 70', org_id: '' }, custom: { segment: null, industry: null, tags: null } },
  });
  await db.sql`UPDATE clients SET custom = custom || ${db.json({ secret: 'засекречено' }) as never} WHERE id = ${clientOf('a', 70)}`;
  await updateClient(rop, clientOf('a', 70), { set: { system: { region: 'Алматы' }, custom: {} }, expect: { system: { region: '' }, custom: {} } });
});
after(() => closeClientsWorld(db));

const q = (s: string) => parseListQuery(new URLSearchParams(s));
const find = async (user: string, s: string) => (await listClients(await viewerOf(user), q(s))).items.map((i) => i.id);

test('название: с формой собственности и без, регистр и казахские буквы', async () => {
  for (const s of ['q=Қазына', 'q=казына', 'q=КАЗЫНА+АЙ', 'q=ТОО+Қазына', 'q=азына']) {
    assert.deepEqual(await find(U.opA, s), [clientOf('a', 70)], s);
  }
});

test('номер: с 8, с +7, со скобками; БИН', async () => {
  const digits = phoneOf('a', 70);
  const national = digits.slice(1);
  for (const s of [`q=${digits}`, `q=%2B7+${national.slice(0, 3)}+${national.slice(3)}`, `q=8${national}`, `q=8+(${national.slice(0, 3)})+${national.slice(3, 6)}-${national.slice(6)}`]) {
    assert.deepEqual(await find(U.opA, s), [clientOf('a', 70)], s);
  }
  assert.deepEqual(await find(U.opA, 'q=987654321098'), [clientOf('a', 70)]);
  assert.deepEqual(await find(U.opA, 'q=654321098'), [clientOf('a', 70)]);
});

test('значение поля, видимого всем ролям, находится; скрытого хоть одной роли — нет', async () => {
  assert.deepEqual(await find(U.opA, 'q=оптовая+торговля'), [clientOf('a', 70)]);
  assert.deepEqual(await find(U.opA, 'q=засекречено'), []);
  assert.deepEqual(await find(U.rop, 'q=засекречено'), []);
});

test('слишком короткий запрос: подсказка, без поиска', async () => {
  const v = await viewerOf(U.opA);
  for (const s of ['q=ab', 'q=1234', 'q=%2B7+7']) {
    const r = await listClients(v, q(s));
    assert.deepEqual(r, { items: [], next: null, hint: 'short' }, s);
  }
});

test('больше 20 совпадений — 20 и «ещё»; без поиска — 50; курсор доводит до конца без повторов', async () => {
  const v = await viewerOf(U.opA);
  const searched = await listClients(v, q('q=синтетика'));
  assert.equal(searched.items.length, 20);
  assert.ok(searched.next);
  const plain = await listClients(v, q(''));
  assert.equal(plain.items.length, 50);
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const p = await listClients(v, q(cursor ? `cursor=${cursor}` : ''));
    for (const it of p.items) {
      assert.ok(!ids.has(it.id), 'повтор');
      ids.add(it.id);
    }
    if (!p.next) break;
    cursor = p.next;
  }
  assert.equal(ids.size, 100, 'оператор видит ровно свои 100 карточек');
});

test('охват: оператор не находит клиентов другого оператора ни по названию, ни по номеру, ни по БИН', async () => {
  await db.sql`UPDATE clients SET org_id = '121212121212', search_norm = search_norm || ' 121212121212' WHERE id = ${clientOf('b', 1)}`;
  assert.deepEqual(await find(U.opA, 'q=бета'), []);
  assert.deepEqual(await find(U.opA, `q=${phoneOf('b', 1)}`), []);
  assert.deepEqual(await find(U.opA, 'q=121212121212'), []);
  assert.deepEqual(await find(U.opB, 'q=121212121212'), [clientOf('b', 1)]);
  const all = await find(U.opA, '');
  assert.ok(all.every((id) => id.startsWith('cl-a-')));
  // РОП видит клиентов обоих операторов
  assert.deepEqual(await find(U.rop, 'q=121212121212'), [clientOf('b', 1)]);
});

test('состояния и слитые: фильтр по state; слитый клиент в списке не показывается', async () => {
  await db.sql`UPDATE cards SET state = 'callback' WHERE id = ANY(${['cd-a-80', 'cd-a-81']})`;
  assert.deepEqual((await find(U.opA, 'state=callback')).sort(), ['cl-a-80', 'cl-a-81']);
  await db.sql`UPDATE clients SET merged_into_id = ${clientOf('a', 80)} WHERE id = ${clientOf('a', 81)}`;
  assert.deepEqual(await find(U.opA, 'state=callback'), ['cl-a-80']);
  assert.deepEqual((await find(U.opA, 'state=callback&state=new')).sort(), ['cl-a-80']);
});

test('фильтры полей: фильтруемое видимое поле работает; скрытое, нефильтруемое и неизвестное — 400 одинаково', async () => {
  assert.deepEqual(await find(U.opA, 'f.industry=trade'), [clientOf('a', 70)]);
  assert.deepEqual(await find(U.opA, 'f.tags=vip'), [clientOf('a', 70)]);
  assert.deepEqual(await find(U.opA, 'f.industry=service'), []);
  for (const s of ['f.secret=засекречено', 'f.segment=x', 'f.nope=1', 'f.industry=zzz', 'f.industry=old']) {
    await assert.rejects(listClients(await viewerOf(U.opA), q(s)), (e: { code?: string; detail?: string }) => e.code === 'bad_request' && e.detail === 'field_filter', s);
  }
  // РОП фильтрует по secret (видит как «только чтение»)
  assert.deepEqual(await find(U.rop, 'f.secret=засекречено'), [clientOf('a', 70)]);
});

test('значения полей списка: только showOn.list и только видимые', async () => {
  const v = await viewerOf(U.opA);
  const r = await listClients(v, q('q=казына'));
  assert.deepEqual(r.items[0]?.values, { segment: 'Оптовая торговля' });
  assert.equal(r.items[0]?.primaryPhone, `+${phoneOf('a', 70)}`);
  assert.equal(r.items[0]?.state, 'retry');
});
