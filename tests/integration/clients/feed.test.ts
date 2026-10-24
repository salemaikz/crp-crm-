// Лента клиента (4.8): цепочка слитых, курсор без пропусков и повторов, скрытые поля, группы, реестр видов.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientFeed, updateClient } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { SEED_NOW, SPACE, U, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

async function addEvent(id: string, clientId: string, kind: string, at: number, data: unknown = {}) {
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, data) VALUES (${id}, ${clientId}, ${SPACE}, ${kind}, ${U.opA}, ${at}, ${db.json(data) as never})`;
}

async function allPages(v: Awaited<ReturnType<typeof viewerOf>>, clientId: string, groups: string | null = null) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const p = await getClientFeed(v, clientId, { cursor, groups });
    ids.push(...p.items.map((x) => x.id));
    if (!p.next) return ids;
    cursor = p.next;
  }
  assert.fail('курсор не заканчивается');
}

test('события слитого клиента видны в ленте выжившего; чужой оператор их не видит', async () => {
  const winner = clientOf('a', 60);
  const loser = clientOf('a', 61);
  await db.sql`DELETE FROM client_phones WHERE client_id = ${loser}`;
  await db.sql`DELETE FROM cards WHERE client_id = ${loser}`;
  await db.sql`UPDATE clients SET merged_into_id = ${winner} WHERE id = ${loser}`;
  await addEvent('fe-w', winner, 'call', 10);
  await addEvent('fe-l', loser, 'call', 20);
  const v = await viewerOf(U.opA);
  const ids = await allPages(v, winner);
  assert.ok(ids.includes('fe-w') && ids.includes('fe-l'));
  assert.ok(ids.indexOf('fe-l') < ids.indexOf('fe-w'), 'новые события выше');
  // слитого клиента как адрес ленты нет
  await assert.rejects(getClientFeed(v, loser, { cursor: null, groups: null }), { code: 'not_found' });
  await assert.rejects(getClientFeed(await viewerOf(U.opB), winner, { cursor: null, groups: null }), { code: 'not_found' });
});

test('курсор: 120 событий с одинаковым временем — страницы без пропусков и повторов', async () => {
  const id = clientOf('a', 62);
  for (let i = 0; i < 120; i++) await addEvent(`fc-${String(i).padStart(3, '0')}`, id, 'call', i < 60 ? 1000 : 2000);
  const v = await viewerOf(U.opA);
  const first = await getClientFeed(v, id, { cursor: null, groups: null });
  assert.equal(first.items.length, 50);
  assert.ok(first.next);
  const ids = (await allPages(v, id)).filter((x) => x.startsWith('fc-'));
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, 120);
  // порядок: время по убыванию, при равенстве id по убыванию
  const sorted = [...ids].sort((a, b) => {
    const ta = Number(a.slice(3)) < 60 ? 1000 : 2000;
    const tb = Number(b.slice(3)) < 60 ? 1000 : 2000;
    return tb - ta || (a < b ? 1 : -1);
  });
  assert.deepEqual(ids, sorted);
});

test('событие скрытого поля не приходит оператору и не занимает лимит; РОП видит его как «только чтение»', async () => {
  const id = clientOf('a', 63);
  // 60 скрытых событий свежее обычных
  for (let i = 0; i < 60; i++) await addEvent(`fh-${i}`, id, 'field.changed', 5000 + i, { obj: 'client', sys: false, field: 'secret', before: null, after: `тайна ${i}` });
  for (let i = 0; i < 3; i++) await addEvent(`fv-${i}`, id, 'field.changed', 100 + i, { obj: 'client', sys: false, field: 'segment', before: null, after: `сегмент ${i}` });
  await addEvent('fs-0', id, 'field.changed', 50, { obj: 'client', sys: true, field: 'region', before: null, after: 'Алматы' });
  const op = await viewerOf(U.opA);
  const page = await getClientFeed(op, id, { cursor: null, groups: null });
  assert.equal(page.next, null, 'скрытые не заняли лимит и страницу');
  assert.deepEqual(page.items.map((x) => x.id).sort(), ['fs-0', 'fv-0', 'fv-1', 'fv-2']);
  assert.ok(!JSON.stringify(page).includes('тайна'));
  const rop = await viewerOf(U.rop);
  const ropIds = await allPages(rop, id);
  assert.equal(ropIds.filter((x) => x.startsWith('fh-')).length, 60);
});

test('событие поля, которого нет в настройках, и вид не из реестра не приходят', async () => {
  const id = clientOf('a', 64);
  await addEvent('fx-gone', id, 'field.changed', 10, { obj: 'client', sys: false, field: 'removed_field', before: 1, after: 2 });
  await addEvent('fx-kind', id, 'x.unknown', 11, { stage: 'x' });
  await addEvent('fx-ok', id, 'call', 12, { outcome: 'no_answer', secretKey: 'не должен выйти', durationSec: 5 });
  const v = await viewerOf(U.opA);
  const p = await getClientFeed(v, id, { cursor: null, groups: null });
  assert.deepEqual(p.items.map((x) => x.id), ['fx-ok']);
  // data режется до ключей реестра
  assert.deepEqual(p.items[0]?.data, { outcome: 'no_answer', durationSec: 5 });
  assert.equal(p.items[0]?.group, 'calls');
});

test('фильтр групп: звонки отдельно от системных', async () => {
  const id = clientOf('a', 65);
  await addEvent('fg-call', id, 'call', 10);
  await addEvent('fg-note', id, 'note.created', 11, { noteId: 'n1' });
  await addEvent('fg-sys', id, 'phone.added', 12, { phoneId: 'p1' });
  const v = await viewerOf(U.opA);
  assert.deepEqual(await allPages(v, id, 'calls'), ['fg-call']);
  assert.deepEqual(await allPages(v, id, 'notes,calls'), ['fg-note', 'fg-call']);
  assert.deepEqual(await allPages(v, id, 'system'), ['fg-sys']);
  await assert.rejects(getClientFeed(v, id, { cursor: null, groups: 'nope' }), { code: 'bad_request' });
  await assert.rejects(getClientFeed(v, id, { cursor: '!!', groups: null }), { code: 'bad_request' });
});

test('правка через сервис попадает в ленту того, кто правил, с именем автора', async () => {
  const id = clientOf('a', 66);
  const v = await viewerOf(U.opA);
  await updateClient(v, id, { set: { system: { region: 'Караганда' }, custom: {} }, expect: { system: { region: '' }, custom: {} } });
  const p = await getClientFeed(v, id, { cursor: null, groups: 'system' });
  const e = p.items.find((x) => x.kind === 'field.changed');
  assert.equal(e?.actor?.name, 'Оператор Синтетик А');
  assert.equal(e?.at, SEED_NOW);
  assert.deepEqual(e?.data, { obj: 'client', sys: true, field: 'region', before: null, after: 'Караганда' });
});

test('limit=3 отдаёт три последних события со следующей страницей; мусорный limit — 400; чужой клиент — 404 с тем же телом', async () => {
  const id = clientOf('a', 64);
  for (let i = 0; i < 6; i++) await addEvent(`fl-${i}`, id, 'call', 7000 + i);
  const v = await viewerOf(U.opA);
  const page = await getClientFeed(v, id, { cursor: null, groups: 'calls', limit: '3' });
  assert.deepEqual(page.items.map((x) => x.id), ['fl-5', 'fl-4', 'fl-3']);
  assert.ok(page.next);
  const rest = await getClientFeed(v, id, { cursor: page.next, groups: 'calls', limit: '3' });
  assert.deepEqual(rest.items.map((x) => x.id), ['fl-2', 'fl-1', 'fl-0']);
  await assert.rejects(getClientFeed(v, id, { cursor: null, groups: null, limit: '21' }), { code: 'bad_request' });
  await assert.rejects(getClientFeed(v, id, { cursor: null, groups: null, limit: '0' }), { code: 'bad_request' });
  const other = await viewerOf(U.opB);
  const foreign = await getClientFeed(other, id, { cursor: null, groups: null, limit: '3' }).catch((e: unknown) => e as Error & { code: string });
  const missing = await getClientFeed(other, 'no-such-client', { cursor: null, groups: null, limit: '3' }).catch((e: unknown) => e as Error & { code: string });
  assert.equal((foreign as { code: string }).code, 'not_found');
  assert.equal((foreign as Error).message, (missing as Error).message);
  assert.equal((foreign as { code: string }).code, (missing as { code: string }).code);
});
