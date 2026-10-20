// Пропуски (docs/calls-design.md §7): лимит в сутки под блокировкой пропусков, идемпотентность, охват.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { CallsDomainError } from '../../../src/server/domain/calls/errors';
import { submitSkip } from '../../../src/server/domain/calls/skips';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, setCard, uuid, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
let opB: Viewer;
const clock = { now: SEED_NOW };

const fails = (code: string) => (e: unknown) => e instanceof CallsDomainError && e.code === code;
const skipsOf = async (user: string): Promise<number> => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM skips WHERE user_id = ${user}`)[0]!.n;

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  for (let i = 1; i <= 30; i++) await setCard(db.sql, `cd-a-${i}`, { state: 'new', nextCallAt: null });
});
after(() => closeCallsWorld(db));

test('12 одновременных пропусков при лимите 10 → ровно 10 строк, остальные skip_limit с лимитом', async () => {
  const jobs = Array.from({ length: 12 }, (_, i) => submitSkip(deps, opA, { opId: uuid(), cardId: `cd-a-${i + 1}` }).then((r) => ({ ok: r }), (e: unknown) => ({ err: e })));
  const res = await Promise.all(jobs);
  const oks = res.filter((r) => 'ok' in r);
  const errs = res.filter((r) => 'err' in r).map((r) => (r as { err: unknown }).err);
  assert.equal(oks.length, 10);
  assert.equal(errs.length, 2);
  for (const e of errs) {
    assert.ok(fails('skip_limit')(e));
    assert.equal((e as CallsDomainError).extra.skipLimit, 10);
  }
  assert.equal(await skipsOf(U.opA), 10);
  assert.deepEqual(oks.map((r) => (r as { ok: { skipLimit: number } }).ok.skipLimit), Array(10).fill(10));
});

test('повтор opId не считается дважды и отвечает duplicate; чужой opId — 404', async () => {
  const opId = uuid();
  // у B лимит свой
  const first = await submitSkip(deps, opB, { opId, cardId: 'cd-b-1' });
  assert.deepEqual([first.status, first.skipsToday], ['skipped', 1]);
  const again = await submitSkip(deps, opB, { opId, cardId: 'cd-b-1' });
  assert.deepEqual([again.status, again.skipsToday], ['duplicate', 1]);
  assert.equal(await skipsOf(U.opB), 1);
  await assert.rejects(submitSkip(deps, opA, { opId, cardId: 'cd-a-20' }), fails('opid_reused'));
});

test('пропуск чужой и несуществующей карточки — not_found, карточка не меняется', async () => {
  const before = await skipsOf(U.opB);
  await assert.rejects(submitSkip(deps, opB, { opId: uuid(), cardId: 'cd-a-25' }), fails('not_found'));
  await assert.rejects(submitSkip(deps, opB, { opId: uuid(), cardId: 'нет-такой' }), fails('not_found'));
  assert.equal(await skipsOf(U.opB), before);
  const c = await db.sql<{ version: number }>`SELECT version FROM cards WHERE id = 'cd-a-25'`;
  assert.equal(c[0]?.version, 0);
});

test('следующие сутки: счётчик обнуляется', async () => {
  clock.now = SEED_NOW + 24 * 60 * 60_000;
  try {
    const r = await submitSkip(deps, opA, { opId: uuid(), cardId: 'cd-a-21' });
    assert.deepEqual([r.status, r.skipsToday], ['skipped', 1]);
  } finally {
    clock.now = SEED_NOW;
  }
});
