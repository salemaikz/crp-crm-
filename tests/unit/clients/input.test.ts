// Разбор входа API клиентов: тела запросов (строго), курсоры, строка запроса списка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addContactBody,
  addPhoneBody,
  decodeCursor,
  encodeCursor,
  parseBody,
  parseListQuery,
  patchBody,
  patchContactBody,
  patchPhoneBody,
} from '../../../src/server/domain/clients/input';

const UUID = '00000000-0000-4000-8000-000000000001';

test('PATCH клиента: ключи expect совпадают с ключами set', () => {
  const ok = { set: { system: { name: 'А' }, custom: { x: 1 } }, expect: { system: { name: 'Б' }, custom: { x: null } } };
  assert.deepEqual(parseBody(patchBody, ok), ok);
  assert.deepEqual(parseBody(patchBody, { set: {}, expect: {} }), { set: {}, expect: {} });
  assert.throws(() => parseBody(patchBody, { set: { system: { name: 'А' } }, expect: {} }), { code: 'bad_request' });
  assert.throws(() => parseBody(patchBody, { set: { custom: { a: 1 } }, expect: { custom: { b: 1 } } }), { code: 'bad_request' });
});

test('PATCH клиента: лишний ключ верхнего уровня — ошибка', () => {
  assert.throws(() => parseBody(patchBody, { set: {}, expect: {}, version: 1 }), { code: 'bad_request' });
  assert.throws(() => parseBody(patchBody, { set: { other: {} }, expect: {} }), { code: 'bad_request' });
  assert.throws(() => parseBody(patchBody, 'строка'), { code: 'bad_request' });
});

test('номер: opId — uuid, лишнее запрещено', () => {
  assert.equal(parseBody(addPhoneBody, { opId: UUID, phone: '+7 709 555 01 01' }).phone, '+7 709 555 01 01');
  assert.throws(() => parseBody(addPhoneBody, { opId: 'не-uuid', phone: '1' }), { code: 'bad_request' });
  assert.throws(() => parseBody(addPhoneBody, { opId: UUID, phone: '' }), { code: 'bad_request' });
  assert.throws(() => parseBody(addPhoneBody, { opId: UUID, phone: '1', extra: 1 }), { code: 'bad_request' });
  assert.equal(parseBody(addPhoneBody, { opId: UUID, phone: '1', contactId: null }).contactId, null);
});

test('действие над номером: ровно одно', () => {
  assert.deepEqual(parseBody(patchPhoneBody, { working: false }), { working: false });
  assert.deepEqual(parseBody(patchPhoneBody, { primary: true }), { primary: true });
  assert.throws(() => parseBody(patchPhoneBody, { working: false, primary: true }), { code: 'bad_request' });
  assert.throws(() => parseBody(patchPhoneBody, { working: true }), { code: 'bad_request' });
  assert.throws(() => parseBody(patchPhoneBody, {}), { code: 'bad_request' });
});

test('контакт: новый — opId uuid; архив — отдельное тело', () => {
  assert.deepEqual(parseBody(addContactBody, { opId: UUID }), { opId: UUID, system: {}, custom: {} });
  assert.throws(() => parseBody(addContactBody, { opId: 'x' }), { code: 'bad_request' });
  assert.deepEqual(parseBody(patchContactBody, { archived: true }), { archived: true });
  assert.throws(() => parseBody(patchContactBody, { archived: false }), { code: 'bad_request' });
  assert.ok('set' in parseBody(patchContactBody, { set: {}, expect: {} }));
});

test('курсор: кодирование и разбор туда-обратно, мусор — 400', () => {
  const c = { at: 1_790_000_000_000, id: 'cd-a-17' };
  assert.deepEqual(decodeCursor(encodeCursor(c)), c);
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(''), null);
  for (const bad of ['!!!', 'abc', encodeCursor({ at: 1, id: 'x y' }), Buffer.from('12.', 'utf8').toString('base64url'), 'a'.repeat(300)]) {
    assert.throws(() => decodeCursor(bad), { code: 'bad_request' }, bad);
  }
  assert.throws(() => decodeCursor(Buffer.from('99999999999999999999.id', 'utf8').toString('base64url')), { code: 'bad_request' });
});

test('строка запроса списка: состояния, фильтры полей, лимит', () => {
  const q = parseListQuery(new URLSearchParams('q=Пример&state=new&state=retry&state=new&f.industry=trade&limit=500'));
  assert.equal(q.q, 'Пример');
  assert.deepEqual(q.states, ['new', 'retry']);
  assert.deepEqual(q.fieldFilters, [{ key: 'industry', value: 'trade' }]);
  assert.equal(q.limit, 50);
  assert.equal(parseListQuery(new URLSearchParams('')).states, null);
  assert.throws(() => parseListQuery(new URLSearchParams('state=bogus')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('limit=0')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('limit=abc')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('f.A-B=1')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('f.a=1&f.a=2')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('cursor=%%%')), { code: 'bad_request' });
});

test('вид списка (C9): all по умолчанию, mine и archive; owner — только в архиве', () => {
  assert.deepEqual([parseListQuery(new URLSearchParams('')).view, parseListQuery(new URLSearchParams('')).owner], ['all', null]);
  assert.equal(parseListQuery(new URLSearchParams('view=mine')).view, 'mine');
  const a = parseListQuery(new URLSearchParams('view=archive&owner=u-1'));
  assert.deepEqual([a.view, a.owner], ['archive', 'u-1']);
  assert.throws(() => parseListQuery(new URLSearchParams('view=trash')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('view=mine&owner=u-1')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('owner=u-1')), { code: 'bad_request' });
  assert.throws(() => parseListQuery(new URLSearchParams('view=archive&owner=')), { code: 'bad_request' });
});
