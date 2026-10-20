// Исполнитель эффектов карточки на поддельной транзакции: порядок групп и получатель `{ role: 'lead' }`
// (docs/calls-design.md §5, D-176). SQL не выполняется — проверяется, что и в каком порядке уходит в БД.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { calling } from '../../../packages/core/src';
import { overrideAccessForTests, resetAccessForTests } from '../../../src/server/access/testing';
import { applyCardEffects } from '../../../src/server/domain/cards/effects';
import type { CallingContext, EffectCard } from '../../../src/server/domain/cards/types';
import type { Sql } from '../../../src/server/platform/db';
import { configDoc } from '../../isolation/harness/config';

interface Logged {
  text: string;
  values: unknown[];
}

function fakeTx(over: { lead?: Array<{ id: string }> } = {}): { tx: Sql; log: Logged[] } {
  const log: Logged[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    log.push({ text, values });
    if (text.includes('FROM memberships')) return over.lead ?? [{ id: 'lead-1' }];
    return [{ id: 'row-1' }];
  }) as unknown as Sql;
  return { tx, log };
}

const CARD: EffectCard = { id: 'cd-1', clientId: 'cl-1', spaceId: 'sp-1', ownerUserId: 'u-op', actingUserId: null, phoneDigits: new Map([['ph-1', '77090000001']]) };
const CTX = { calendar: { localDay: () => '2026-10-28' } } as unknown as CallingContext;
const ACTOR = { kind: 'user', userId: 'u-op' } as never;

const empty = (): calling.Effects => ({ tasks: [], deals: [], bookings: [], stopList: [], assignLog: [], notifications: [], timeline: [], audit: [], skips: [] });
const tableOf = (t: string): string => /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/.exec(t)?.[1] ?? '?';

before(() => overrideAccessForTests({ config: async () => configDoc(), now: () => 0 }));
after(() => resetAccessForTests());

test('порядок групп: задачи → стоп-лист → журнал раздачи → уведомления → лента → аудит → пропуски', async () => {
  const { tx, log } = fakeTx();
  const e = empty();
  e.skips.push({ opId: 'op-1', day: '2026-10-28' });
  e.audit.push({ kind: 'dnc.cleared', data: { cardId: 'cd-1' } });
  e.timeline.push({ kind: 'card.state', at: 5, actorId: 'u-op', ref: null, data: { fromState: 'new', toState: 'retry', cause: 'x' } });
  e.notifications.push({ kind: 'no_show', to: { user: 'u-op' }, dedupeKey: null });
  e.assignLog.push({ kind: 'transfer', fromUserId: 'u-op', toUserId: 'u-2', countsToCap: false });
  e.stopList.push({ op: 'add', phoneId: 'ph-1', reasonCode: 'asked' });
  e.tasks.push({ op: 'create', source: 'callback', kind: 'call', assignee: { user: 'u-op' }, dueAt: 10, sourceKey: 'callback:op-1' });
  await applyCardEffects(tx, ACTOR, CARD, e, 100, CTX);
  assert.deepEqual(log.map((l) => tableOf(l.text)).filter((t) => t !== '?'), ['tasks', 'stop_list', 'assign_log', 'notifications', 'client_events', 'audit_log', 'skips']);
});

test('стоп-лист: в БД уходит HMAC номера, а не цифры', async () => {
  const { tx, log } = fakeTx();
  const e = empty();
  e.stopList.push({ op: 'add', phoneId: 'ph-1', reasonCode: 'asked' });
  await applyCardEffects(tx, ACTOR, CARD, e, 100, CTX);
  const insert = log.find((l) => tableOf(l.text) === 'stop_list')!;
  assert.ok(insert.values.some((v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)));
  assert.ok(!insert.values.includes('77090000001'));
});

test('номер не с этой карточки — ошибка сборки, а не запись', async () => {
  const { tx } = fakeTx();
  const e = empty();
  e.stopList.push({ op: 'add', phoneId: 'ph-foreign', reasonCode: 'asked' });
  await assert.rejects(applyCardEffects(tx, ACTOR, CARD, e, 100, CTX));
});

test('получатель { role: lead } разрешается в руководителя; задача создаётся ему', async () => {
  const { tx, log } = fakeTx({ lead: [{ id: 'lead-1' }] });
  const e = empty();
  e.tasks.push({ op: 'create', source: 'review', kind: 'check', assignee: { role: 'lead' }, dueAt: null, sourceKey: 'review:op-1' });
  await applyCardEffects(tx, ACTOR, CARD, e, 100, CTX);
  const insert = log.find((l) => tableOf(l.text) === 'tasks')!;
  assert.ok(insert.values.includes('lead-1'));
});

test('руководителя нет — задача не создаётся, остальное выполняется', async () => {
  const { tx, log } = fakeTx({ lead: [] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const e = empty();
    e.tasks.push({ op: 'create', source: 'review', kind: 'check', assignee: { role: 'lead' }, dueAt: null, sourceKey: 'review:op-2' });
    e.notifications.push({ kind: 'no_show', to: { role: 'lead' }, dedupeKey: null });
    e.timeline.push({ kind: 'card.state', at: 5, actorId: null, ref: null, data: {} });
    await applyCardEffects(tx, ACTOR, CARD, e, 100, CTX);
  } finally {
    console.warn = warn;
  }
  assert.equal(log.some((l) => tableOf(l.text) === 'tasks'), false);
  assert.equal(log.some((l) => tableOf(l.text) === 'notifications'), false);
  assert.equal(log.some((l) => tableOf(l.text) === 'client_events'), true);
});

test('закрытие и передача открытых задач идут по клиенту и пространству', async () => {
  const { tx, log } = fakeTx();
  const e = empty();
  e.tasks.push({ op: 'close', sources: 'all' }, { op: 'close_by_key', sourceKey: 'k' }, { op: 'reassign_open', to: 'u-2' });
  await applyCardEffects(tx, ACTOR, { ...CARD, priorOwnerUserId: 'u-op', priorActingUserId: 'u-temp' }, e, 100, CTX);
  assert.equal(log.filter((l) => tableOf(l.text) === 'tasks').length, 3);
  const reassign = log.filter((l) => tableOf(l.text) === 'tasks')[2]!;
  assert.deepEqual(reassign.values.find(Array.isArray), ['u-op', 'u-temp'], 'забираем задачи прежнего и временного владельца (D-254)');
});

test('передача без прежнего владельца и временного задач не трогает (D-254)', async () => {
  const { tx, log } = fakeTx();
  const e = empty();
  e.tasks.push({ op: 'reassign_open', to: 'u-2' });
  await applyCardEffects(tx, ACTOR, { ...CARD, priorOwnerUserId: null, priorActingUserId: null }, e, 100, CTX);
  assert.equal(log.filter((l) => tableOf(l.text) === 'tasks').length, 0);
});

test('пропуск без сотрудника (система) — ошибка сборки', async () => {
  const { tx } = fakeTx();
  const e = empty();
  e.skips.push({ opId: 'op-1', day: '2026-10-28' });
  await assert.rejects(applyCardEffects(tx, { kind: 'system', job: 'x', now: 1 } as never, CARD, e, 100, CTX));
});

test('журнал раздачи несёт opId как run_id', async () => {
  const { tx, log } = fakeTx();
  const e = empty();
  e.assignLog.push({ kind: 'transfer', fromUserId: 'u-op', toUserId: 'u-2', countsToCap: false });
  await applyCardEffects(tx, ACTOR, { ...CARD, opId: 'op-77' }, e, 100, CTX);
  assert.ok(log.find((l) => tableOf(l.text) === 'assign_log')!.values.includes('op-77'));
});
