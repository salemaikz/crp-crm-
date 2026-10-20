// Паритет пакетной записи выдачи с ядром `calling` (событие `assign`, переход № 2, D-173):
// те же вид и вхождение в лимит, данные ленты, ключ уведомления; владелец и версия — как в снимке ядра.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calling, time } from '../../../packages/core/src';
import { assignRows } from '../../../src/server/domain/distribution/assign';

const NOW = Date.UTC(2026, 9, 28, 6, 0);
const RUN = '00000000-0000-4000-8000-0000000000d1';

const calendar = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
});

const SETTINGS: calling.CallingSettings = {
  outcomes: [],
  lprRequiredOnContact: false,
  lprNoRequiresInfo: false,
  callbackPastToleranceMin: 5,
  offlineWindowHours: 24,
  retry: { steps: ['+1h'], maxAttempts: 3 },
  returnDays: { not_interested: 30, deal_lost_soft: 30 },
  skipLimit: 5,
  capIncludes: ['auto', 'return'],
  noShowCallbackAt: 'nextWorkday@10:00',
  nextStepTaskAt: 'nextWorkday@10:00',
  autoNoShowWorkdays: null,
  inboundReplyMinutes: 30,
};

function poolCard(): calling.CardSnapshot {
  return {
    id: 'cd-1', clientId: 'cl-1', ownerUserId: null, actingUserId: null, actingUntilDay: '', state: 'new', holdReason: '',
    attempts: 0, nextCallAt: null, returnAt: null, lpr: '', isTarget: '', lastOutcomeCode: '', lastOutcomeKind: '', lastOutcomeAt: null,
    closeReasonCode: '', closedAt: null, assignedAt: null, touchedInCrm: false, callsTotal: 0, connectsTotal: 0, noAnswerTotal: 0,
    firstConnectAt: null, lastConnectAt: null, lastTouchAt: null, version: 4, phones: [],
  };
}

for (const mode of ['auto', 'manual'] as const) {
  test(`паритет с ядром: выдача «${mode}»`, () => {
    const actorId = mode === 'manual' ? 'u-rop' : null;
    const core = calling.applyOutcome({
      card: poolCard(),
      event: { type: 'assign', opId: RUN, mode, toUserId: 'u-op-a', runId: RUN, seenVersion: null, facts: { capRemaining: 5 } },
      actor: { userId: actorId, kind: actorId ? 'user' : 'system', scope: 'space' },
      now: NOW,
      settings: SETTINGS,
      calendar,
    });
    assert.equal(core.status, 'applied');
    if (core.status !== 'applied') return;

    const countsToCap = SETTINGS.capIncludes.includes(mode);
    let n = 0;
    const rows = assignRows({ runId: RUN, kind: mode, countsToCap }, { 'u-op-a': ['cd-1'] }, new Map([['cd-1', 'cl-1']]), () => `id-${n++}`);

    // владелец и версия (версию + 1 делает UPDATE репозитория)
    assert.deepEqual(rows.owners, [{ cardId: 'cd-1', ownerUserId: core.card.ownerUserId as string }]);
    assert.equal(core.card.version, poolCard().version + 1);
    assert.equal(core.card.assignedAt, NOW);
    assert.equal(core.card.touchedInCrm, false, 'раздача не ставит touched_in_crm (D-145)');
    // журнал
    const coreLog = core.effects.assignLog[0];
    assert.ok(coreLog);
    assert.equal(rows.log.length, 1);
    assert.equal(rows.log[0]?.kind, coreLog.kind);
    assert.equal(rows.log[0]?.countsToCap, coreLog.countsToCap);
    assert.equal(rows.log[0]?.toUserId, coreLog.toUserId);
    // лента
    const coreEvent = core.effects.timeline[0];
    assert.ok(coreEvent);
    assert.equal(coreEvent.kind, 'card.assigned');
    assert.deepEqual(rows.events[0]?.data, coreEvent.data);
    // уведомление
    const coreNote = core.effects.notifications[0];
    assert.ok(coreNote);
    assert.equal(rows.notifications[0]?.kind, coreNote.kind);
    assert.equal(rows.notifications[0]?.dedupeKey, coreNote.dedupeKey);
    assert.deepEqual(coreNote.to, { user: rows.notifications[0]?.userId });
  });
}

test('одно сводное уведомление на оператора, число карточек в счётчике', () => {
  const rows = assignRows(
    { runId: RUN, kind: 'auto', countsToCap: true },
    { 'u-b': ['c3'], 'u-a': ['c1', 'c2'], 'u-c': [] },
    new Map([['c1', 'k1'], ['c2', 'k2'], ['c3', 'k3']]),
  );
  assert.deepEqual(rows.notifications.map((x) => [x.userId, x.count, x.dedupeKey]), [
    ['u-a', 2, `assign:${RUN}:u-a`],
    ['u-b', 1, `assign:${RUN}:u-b`],
  ]);
  assert.equal(rows.log.length, 3);
  assert.equal(rows.events.length, 3);
  assert.ok(new Set([...rows.log, ...rows.events, ...rows.notifications].map((r) => r.id)).size === 3 + 3 + 2, 'id уникальны');
});

test('карточка без клиента — ошибка сборки, а не молчаливая потеря', () => {
  assert.throws(() => assignRows({ runId: RUN, kind: 'auto', countsToCap: true }, { 'u-a': ['c1'] }, new Map()));
});
