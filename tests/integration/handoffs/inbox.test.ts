// Входящие передачи (B6b, §7.2, §7.5): кто что видит. Глава отдела — ждущие и принятые своего отдела;
// исполнитель — назначенные ему; РОП и директор — все по роли; чужой отдел и отклонённые отделу не видны.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import { getHandoff, listHandoffMembers, listHandoffs } from '../../../src/server/domain/handoffs';
import { acceptHandoff, assignHandoff, declineHandoff } from '../../../src/server/domain/handoffs';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { OTHER_HEAD, U, teamDesign, buy, closeHandoffsWorld, openHandoffsWorld, uuid, viewerOf } from './helpers';

let db: TestDb;
let pending: string;
let accepted: string;
let declined: string;
let foreign: string;

before(async () => {
  db = await openHandoffsWorld();
  pending = (await buy(41)).handoffId;
  accepted = (await buy(42)).handoffId;
  declined = (await buy(43)).handoffId;
  foreign = (await buy(44)).handoffId;
  const head = await viewerOf(U.mktHead);
  await acceptHandoff(head, { handoffId: accepted, opId: uuid() });
  await assignHandoff(head, { handoffId: accepted, opId: uuid(), userId: U.marketer });
  await declineHandoff(head, { handoffId: declined, opId: uuid(), reason: 'Синтетическая причина' });
  // передача другому отделу (в обход сервиса покупки)
  await db.sql`UPDATE handoffs SET team_id = ${teamDesign} WHERE id = ${foreign}`;
});
after(() => closeHandoffsWorld(db));

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test('глава отдела: ждущая и принятая своего отдела; чужого отдела и отклонённой нет', async () => {
  const head = await viewerOf(U.mktHead);
  const items = await listHandoffs(head, {});
  assert.ok(ids(items).includes(pending) && ids(items).includes(accepted));
  assert.ok(!ids(items).includes(foreign) && !ids(items).includes(declined));
  const p = items.find((x) => x.id === pending)!;
  assert.deepEqual([p.status, p.can, p.overdue, p.serviceTypeKey, p.declinedReason], ['pending', { accept: true, decline: true, assign: true }, false, 'smm', null]);
  // ждущие сверху
  assert.equal(items[0]?.status, 'pending');
});

test('глава отдела: карточка чужого отдела и отклонённой — 404', async () => {
  const head = await viewerOf(U.mktHead);
  await assert.rejects(() => getHandoff(head, foreign), NotFoundError);
  await assert.rejects(() => getHandoff(head, declined), NotFoundError);
  await assert.rejects(() => getHandoff(head, 'нет-такой'), NotFoundError);
  assert.equal((await getHandoff(head, pending)).id, pending);
});

test('другой глава видит только свою передачу', async () => {
  const other = await viewerOf(OTHER_HEAD);
  assert.deepEqual(ids(await listHandoffs(other, {})), [foreign]);
});

test('маркетолог: только назначенные ему, без кнопок', async () => {
  const m = await viewerOf(U.marketer);
  const items = await listHandoffs(m, {});
  assert.ok(ids(items).includes(accepted));
  assert.ok(!ids(items).includes(pending));
  assert.ok(items.every((x) => x.assigneeUserId === U.marketer && !x.can.accept && !x.can.assign));
  await assert.rejects(() => getHandoff(m, pending), NotFoundError);
  await assert.rejects(() => listHandoffMembers(m, accepted), NotFoundError);
});

test('РОП и директор видят все, причина отказа — у отклонённой; кнопок нет', async () => {
  for (const who of [U.rop, U.director]) {
    const v = await viewerOf(who);
    const all = await listHandoffs(v, { statuses: ['pending', 'accepted', 'declined', 'cancelled'] });
    for (const id of [pending, accepted, declined, foreign]) assert.ok(ids(all).includes(id), `${who} видит ${id}`);
    const d = all.find((x) => x.id === declined)!;
    assert.equal(d.declinedReason, 'Синтетическая причина');
    assert.ok(all.every((x) => !x.can.accept && !x.can.assign));
  }
});

test('оператор: ни списка, ни карточки', async () => {
  const op = await viewerOf(U.opA);
  assert.deepEqual(await listHandoffs(op, {}), []);
  await assert.rejects(() => getHandoff(op, pending), NotFoundError);
});

test('сотрудники отдела для назначения: только активные члены отдела передачи', async () => {
  const head = await viewerOf(U.mktHead);
  const members = await listHandoffMembers(head, pending);
  const got = members.map((m) => m.userId).sort();
  assert.deepEqual(got, [U.marketer, U.mktHead].sort());
  await assert.rejects(() => listHandoffMembers(head, foreign), NotFoundError);
});
