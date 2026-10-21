// Порядок блокировок (docs/tasks-team-design.md §1.2): тх, берущая advisory-блокировку приёма INTAKE, первой командой
// ставит `SET LOCAL lock_timeout = '10s'`. Иначе «Предложить контакт» и разбор предложения РОП ждут чужую длинную
// тх приёма бесконечно, занимая соединения пула. Проверка: блокировку держит другая тх — оба вызова падают
// по таймауту блокировки (55P03), а не висят. Только синтетика (+7 709 …).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { overrideDistributionDepsForTests } from '../../../src/server/domain/distribution/deps';
import { resolveProposal } from '../../../src/server/domain/distribution';
import { proposeContact } from '../../../src/server/domain/intake';
import { INTAKE_LOCK_KEY } from '../../../src/server/platform/db/locks';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { closeCallsWorld, openCallsWorld, uuid, viewerOf } from '../calls/world';
import { SEED_NOW, makeDeps, type Clock } from '../distribution/helpers';

let db: TestDb;
const clock: Clock = { now: SEED_NOW };

before(async () => {
  db = await openCallsWorld();
  overrideDistributionDepsForTests(makeDeps(clock));
});
after(async () => {
  overrideDistributionDepsForTests(null);
  await closeCallsWorld(db);
});

/** Держать INTAKE в отдельной тх, пока не вызван release. */
async function holdIntake(): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const done = db.tx(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
    locked();
    await gate;
  });
  await ready;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => String((e as { code?: unknown }).code ?? e));

test('«Предложить контакт» и разбор предложения не ждут блокировку приёма дольше lock_timeout', { timeout: 60_000 }, async () => {
  const op = await viewerOf(U.opA);
  const rop = await viewerOf(U.rop);
  const hold = await holdIntake();
  let guard: NodeJS.Timeout | undefined;
  try {
    const hung = new Promise<string>((r) => (guard = setTimeout(() => r('hung'), 25_000)));
    const [propose, resolve] = await Promise.all([
      Promise.race([outcome(proposeContact(op, { opId: uuid(), phone: '+7 709 555 07 07', name: 'ТОО Синтетика Блокировка' })), hung]),
      Promise.race([outcome(resolveProposal(rop, 'pr-no-such', { opId: uuid(), decision: 'reject' })), hung]),
    ]);
    assert.deepEqual([propose, resolve], ['55P03', '55P03']);
  } finally {
    clearTimeout(guard);
    await hold.release();
  }
});
