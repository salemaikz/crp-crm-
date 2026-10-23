// Паритет пакета передачи с ядром `calling.applyOutcome({type:'transfer'})` (B9a, docs/tasks-team-design.md §6.3):
// те же вид журнала, вхождение в лимит, вид ленты и уведомления, прирост версии; владелец и временный снимаются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calling, time } from '../../../packages/core/src';
import { TRANSFER_ROWS } from '../../../src/server/domain/team/plan';

const NOW = Date.UTC(2026, 9, 28, 6, 0);

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

const card = (state: calling.CardSnapshot['state']): calling.CardSnapshot => ({
  id: 'cd-1', clientId: 'cl-1', ownerUserId: 'u-a', actingUserId: 'u-t', actingUntilDay: '2026-10-30', state, holdReason: '',
  attempts: 1, nextCallAt: NOW + 3_600_000, returnAt: null, lpr: '', isTarget: '', lastOutcomeCode: '', lastOutcomeKind: '', lastOutcomeAt: null,
  closeReasonCode: '', closedAt: null, assignedAt: null, touchedInCrm: true, callsTotal: 2, connectsTotal: 1, noAnswerTotal: 1,
  firstConnectAt: null, lastConnectAt: null, lastTouchAt: null, version: 7, phones: [], callbackReason: '', callbackTouches: 0, nextCallPrecision: 'time',
});

for (const state of ['retry', 'callback', 'agreed', 'new'] as const) {
  test(`паритет пакета передачи с ядром: ${state}`, () => {
    const r = calling.applyOutcome({
      card: card(state),
      event: { type: 'transfer', opId: 'op-1', toUserId: 'u-b', seenVersion: 7, facts: { toUserActive: true } },
      actor: { userId: 'u-rop', kind: 'user', scope: 'space' },
      now: NOW,
      settings: SETTINGS,
      calendar,
    });
    assert.equal(r.status, 'applied');
    if (r.status !== 'applied') return;
    // владелец — получатель, временный снят, версия растёт на константу пакета
    assert.equal(r.card.ownerUserId, 'u-b');
    assert.equal(r.card.actingUserId, null);
    assert.equal(r.card.actingUntilDay, '');
    assert.equal(r.card.version, 7 + TRANSFER_ROWS.versionDelta);
    // журнал: вид и расход лимита
    assert.deepEqual(r.effects.assignLog.map((l) => [l.kind, l.countsToCap, l.fromUserId, l.toUserId]), [[TRANSFER_ROWS.assignKind, TRANSFER_ROWS.countsToCap, 'u-a', 'u-b']]);
    // лента и уведомление: вид и данные
    assert.deepEqual(r.effects.timeline.map((e) => [e.kind, e.data]), [[TRANSFER_ROWS.feedKind, { fromUserId: 'u-a', toUserId: 'u-b' }]]);
    assert.deepEqual(r.effects.notifications.map((n) => n.kind), [TRANSFER_ROWS.notificationKind]);
    // эффекты на связанные объекты: открытые задачи, сделки и будущие записи — получателю
    assert.deepEqual(r.effects.tasks, [{ op: 'reassign_open', to: 'u-b' }]);
    assert.deepEqual(r.effects.deals, [{ op: 'reassign_open', to: 'u-b' }]);
    assert.deepEqual(r.effects.bookings, [{ op: 'reassign_future', to: 'u-b' }]);
    // состояние карточки передача не меняет
    assert.equal(r.card.state, state);
  });
}
