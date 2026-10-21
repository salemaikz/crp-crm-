// B9b (docs/tasks-team-design.md §7.2, PROCESS 7.6, D-272): спорные пары РОП — список по охвату и решение по паре.
// Синтетика мира изоляции: номера +7 709 …, «ТОО Синтетика …».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { listPairs, resolvePair } from '../../../src/server/domain/distribution';
import { MergeError } from '../../../src/server/domain/intake';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { phoneHmac } from '../../../src/server/platform/hmac';
import { SEED_NOW, U, phoneOf } from '../../isolation/harness/seed';
import { closeCallsWorld, openCallsWorld, setCard, viewerOf } from '../calls/world';

let db: TestDb;
let rop: Viewer;
let opA: Viewer;
let director: Viewer;
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);
const detail = (e: Error | null) => (e instanceof MergeError ? e.detail : e?.constructor.name ?? null);

async function pair(id: string, a: string, b: string, reason = 'shared_phone'): Promise<void> {
  await db.sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, created_at) VALUES (${id}, ${a}, ${b}, ${reason}, ${SEED_NOW})`;
}

before(async () => {
  db = await openCallsWorld();
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  director = await viewerOf(U.director);
});
after(async () => {
  await closeCallsWorld(db);
});

test('список: стороны с номерами и отметкой общего, сторона из другого отдела скрыта; оператору — 403', async () => {
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, created_at) VALUES ('ph-pr-60', 'cl-b-60', ${phoneOf('a', 60)}, 'mobile', ${SEED_NOW})`;
  await pair('pr-60', 'cl-a-60', 'cl-b-60');
  // свой номер Б в «Не звонить»: цифры не показываются
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac(phoneOf('b', 60))}, 'dnc', 'manual', ${SEED_NOW})`;
  // клиент только в другом пространстве: сторона не видна, пара всё равно видна по второй стороне
  await db.sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES ('sp-pr-2', 'pr2', FALSE, ${SEED_NOW})`;
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at)
               VALUES ('cl-pr-x', 'company', 'ТОО Пример Скрытый', 'пример скрытый', 'manual', ${SEED_NOW}, ${SEED_NOW})`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, state, created_at, updated_at) VALUES ('cd-pr-x', 'sp-pr-2', 'cl-pr-x', 'new', ${SEED_NOW}, ${SEED_NOW})`;
  await pair('pr-61', 'cl-a-61', 'cl-pr-x', 'name_and_head');
  // пара, обе стороны которой в чужом отделе, не выводится
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at)
               VALUES ('cl-pr-y', 'company', 'ТОО Пример Скрытый 2', 'пример скрытый 2', 'manual', ${SEED_NOW}, ${SEED_NOW})`;
  await pair('pr-62', 'cl-pr-x', 'cl-pr-y');

  const items = await listPairs(rop);
  const p60 = items.find((p) => p.id === 'pr-60');
  assert.ok(p60?.a && p60.b);
  assert.equal(p60.a.name, 'ТОО Синтетика Альфа 60');
  assert.deepEqual(p60.a.phones.map((x) => [x.phone, x.shared]), [[`+${phoneOf('a', 60)}`, true]]);
  assert.deepEqual(
    p60.b.phones.map((x) => [x.phone, x.shared, x.stopListed]),
    [[null, false, true], [`+${phoneOf('a', 60)}`, true, false]],
  );
  assert.doesNotMatch(JSON.stringify(items), new RegExp(phoneOf('b', 60)));
  const p61 = items.find((p) => p.id === 'pr-61');
  assert.ok(p61?.a);
  assert.equal(p61.b, null);
  assert.doesNotMatch(JSON.stringify(items), /Скрытый/);
  assert.equal(items.some((p) => p.id === 'pr-62'), false);

  assert.ok((await failure(listPairs(opA))) instanceof ForbiddenError);
  // у директора мира нет права читать пул — раздела нет
  assert.ok((await failure(listPairs(director))) instanceof ForbiddenError);
});

test('«Разные — тому же оператору»: пара distinct, задержка «Возможный дубль» снята; повтор — тот же ответ, другое решение — 409', async () => {
  await setCard(db.sql, 'cd-a-63', { owner: null, state: 'new', holdReason: 'dup_pair' });
  await setCard(db.sql, 'cd-b-63', { owner: null, state: 'new', holdReason: 'dup_pair' });
  // у cd-b-64 есть ещё одна открытая пара — задержка остаётся
  await setCard(db.sql, 'cd-b-64', { owner: null, state: 'new', holdReason: 'dup_pair' });
  await pair('pr-63', 'cl-a-63', 'cl-b-63');
  await pair('pr-64', 'cl-a-64', 'cl-b-64');
  await pair('pr-64x', 'cl-b-63', 'cl-b-64', 'name_and_head');

  const r = await resolvePair(rop, 'pr-63', { decision: 'distinct', comment: '' });
  assert.deepEqual(r, { status: 'distinct', released: 1, replayed: false });
  const holds = await db.sql<{ id: string; hold: string; version: number }>`SELECT id, hold_reason AS hold, version FROM cards WHERE id IN ('cd-a-63','cd-b-63') ORDER BY id`;
  // cd-b-63 ещё в открытой паре pr-64x — остаётся задержанной
  assert.deepEqual(holds.map((h) => [h.id, h.hold]), [['cd-a-63', ''], ['cd-b-63', 'dup_pair']]);
  const [row] = await db.sql<{ status: string; resolvedBy: string }>`SELECT status, resolved_by FROM dup_pairs WHERE id = 'pr-63'`;
  assert.deepEqual([row?.status, row?.resolvedBy], ['distinct', U.rop]);
  const audit = await db.sql<{ entity: string; meta: unknown }>`SELECT entity, meta FROM audit_log WHERE action = 'pair.resolve' AND entity_id = 'pr-63'`;
  assert.deepEqual(audit, [{ entity: 'pair', meta: { decision: 'distinct', reason: 'shared_phone', released: 1, withComment: false } }]);

  assert.deepEqual(await resolvePair(rop, 'pr-63', { decision: 'distinct', comment: '' }), { status: 'distinct', released: 0, replayed: true });
  assert.equal(detail(await failure(resolvePair(rop, 'pr-63', { decision: 'split_allowed', comment: 'x' }))), 'not_open');

  // последняя открытая пара решена — задержка снимается
  await resolvePair(rop, 'pr-64x', { decision: 'distinct', comment: '' });
  const [b63] = await db.sql<{ hold: string }>`SELECT hold_reason AS hold FROM cards WHERE id = 'cd-b-63'`;
  assert.equal(b63?.hold, '');
});

test('«Выдать другому»: при общем рабочем номере нужен комментарий; нерабочий общий номер — без комментария', async () => {
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, created_at) VALUES ('ph-pr-65', 'cl-b-65', ${phoneOf('a', 65)}, 'mobile', ${SEED_NOW})`;
  await pair('pr-65', 'cl-a-65', 'cl-b-65');
  assert.equal(detail(await failure(resolvePair(rop, 'pr-65', { decision: 'split_allowed', comment: '  ' }))), 'comment_required');
  const r = await resolvePair(rop, 'pr-65', { decision: 'split_allowed', comment: 'Общий бухгалтер, разные компании' });
  assert.equal(r.status, 'split_allowed');
  const [row] = await db.sql<{ comment: string }>`SELECT comment FROM dup_pairs WHERE id = 'pr-65'`;
  assert.equal(row?.comment, 'Общий бухгалтер, разные компании');

  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_working, created_at) VALUES ('ph-pr-66', 'cl-b-66', ${phoneOf('a', 66)}, 'mobile', FALSE, ${SEED_NOW})`;
  await pair('pr-66', 'cl-a-66', 'cl-b-66');
  assert.equal((await resolvePair(rop, 'pr-66', { decision: 'split_allowed', comment: '' })).status, 'split_allowed');
});

test('решение: оператору — 403, директору — нет права записи, чужая или несуществующая пара — 404', async () => {
  await pair('pr-67', 'cl-a-67', 'cl-b-67');
  assert.ok((await failure(resolvePair(opA, 'pr-67', { decision: 'distinct', comment: '' }))) instanceof ForbiddenError);
  assert.ok((await failure(resolvePair(director, 'pr-67', { decision: 'distinct', comment: '' }))) instanceof ForbiddenError);
  assert.ok((await failure(resolvePair(rop, 'pr-zz', { decision: 'distinct', comment: '' }))) instanceof NotFoundError);
  assert.ok((await failure(resolvePair(rop, 'pr-62', { decision: 'distinct', comment: '' }))) instanceof NotFoundError);
  const [row] = await db.sql<{ status: string }>`SELECT status FROM dup_pairs WHERE id = 'pr-62'`;
  assert.equal(row?.status, 'open');
});
