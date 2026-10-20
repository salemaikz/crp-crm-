// Свойства машины состояний (K1d): детерминированный генератор с seed, без новых зависимостей.
// Проверяем не отдельные сценарии, а инварианты на тысячах случайных входов.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOutcome } from './applyOutcome.js';
import { TEST_SETTINGS } from './spec/vectors.js';
import { CARD_STATES, type Actor, type CallingSettings, type CardEvent, type CardSnapshot, type CardState, type Ms, type TransitionInput } from './spec/types.js';
import { createWorkCalendar } from '../time';

const CASES = 2500;

/** mulberry32: маленький детерминированный генератор. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

const HOUR = 3_600_000;
const hours = { start: '09:00', end: '18:00' };
const CAL = createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: hours,
  callWindow: hours,
  holidays: [{ date: '2026-10-26', kind: 'holiday' }, { date: '2026-11-07', kind: 'workday' }],
});
// 2026-10-19 00:00 по Алматы (UTC+5) — начало диапазона времён.
const T0 = Date.UTC(2026, 9, 19) - 5 * HOUR;

const OP: Actor = { userId: 'u-a', kind: 'user', scope: 'own' };
const LEAD: Actor = { userId: 'u-lead', kind: 'user', scope: 'space' };
const SYS: Actor = { userId: null, kind: 'system', scope: 'space' };

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

/** Время в окне звонков (карточка в БД хранит срок, который уже прошёл через календарь). */
const inWindow = (r: Rng): Ms => CAL.nextCallMoment(T0 + r.int(0, 14 * 24) * HOUR + r.int(0, 59) * 60_000);

function genSettings(r: Rng): CallingSettings {
  const maxAttempts = r.int(1, 6);
  const pickStep = () => (r.chance(0.4) ? `nextWorkday@${r.pick(['09:00', '10:00', '12:30', '17:59'])}` : `+${r.int(1, 30)}${r.pick(['h', 'm'])}`);
  const steps = Array.from({ length: r.int(Math.max(1, maxAttempts - 1), maxAttempts + 1) }, pickStep);
  return { ...TEST_SETTINGS, retry: { steps, maxAttempts } };
}

function genCard(r: Rng, s: CallingSettings, wanted: CardState = r.pick(CARD_STATES)): CardSnapshot {
  // При maxAttempts = 1 карточка не может быть в повторе: первый же недозвон её списывает.
  const state: CardState = wanted === 'retry' && s.retry.maxAttempts < 2 ? 'new' : wanted;
  const working = state === 'new' || state === 'retry' || state === 'callback';
  const version = r.int(1, 20);
  return {
    id: 'card-1',
    clientId: 'client-1',
    ownerUserId: r.chance(0.9) ? 'u-a' : 'u-b',
    actingUserId: null,
    actingUntilDay: '',
    state,
    holdReason: '',
    attempts: state === 'retry' ? r.int(1, s.retry.maxAttempts - 1) : state === 'written_off' ? s.retry.maxAttempts : 0,
    nextCallAt: working && state !== 'new' ? inWindow(r) : null,
    returnAt: state === 'not_interested' ? inWindow(r) : null,
    lpr: r.pick(['', 'yes', 'no'] as const),
    isTarget: r.pick(['', 'yes', 'no'] as const),
    lastOutcomeCode: '',
    lastOutcomeKind: '',
    lastOutcomeAt: r.chance(0.5) ? inWindow(r) : null,
    closeReasonCode: working ? '' : 'r1',
    closedAt: working ? null : inWindow(r),
    assignedAt: T0,
    touchedInCrm: r.chance(0.5),
    callsTotal: r.int(0, 10),
    connectsTotal: r.int(0, 5),
    noAnswerTotal: r.int(0, 5),
    firstConnectAt: null,
    lastConnectAt: null,
    lastTouchAt: null,
    version,
    phones: [
      { id: 'ph-1', kind: 'mobile', isWorking: true, isPrimary: true, inStopList: state === 'do_not_call', sharedWithOtherClient: false, heldByOtherDncClient: false },
      { id: 'ph-2', kind: 'landline', isWorking: r.chance(0.7), isPrimary: false, inStopList: state === 'do_not_call', sharedWithOtherClient: r.chance(0.2), heldByOtherDncClient: false },
    ],
  };
}

function genOutcomeEvent(r: Rng, now: Ms): CardEvent {
  const key = r.chance(0.03) ? 'unknown_key' : r.pick(TEST_SETTINGS.outcomes).key;
  const occurredAt = now - r.int(0, 80 * 60) * 60_000 + (r.chance(0.05) ? r.int(1, 20) * 60_000 : 0);
  const callbackAt = r.chance(0.2) ? null : now + r.int(-3, 120) * HOUR + r.int(0, 59) * 60_000;
  return {
    type: 'outcome',
    opId: `op-${r.int(1, 1e9)}`,
    outcomeKey: key,
    via: r.pick(['ui', 'offline', 'manual_entry', 'telephony'] as const),
    occurredAt,
    receivedAt: now,
    phoneId: r.chance(0.9) ? r.pick(['ph-1', 'ph-2']) : null,
    reasonCode: r.chance(0.7) ? 'r1' : '',
    hasNote: r.chance(0.5),
    lpr: r.pick(['', 'yes', 'no'] as const),
    lprInfoFilled: r.chance(0.5),
    callbackAt,
    markTarget: r.chance(0.3),
    alsoDncPhoneIds: r.chance(0.2) ? ['ph-2'] : [],
    agreement: r.chance(0.5) ? { contactId: 'c-1', bookingId: r.chance(0.5) ? 'bk-1' : null, agreedDueAt: r.chance(0.5) ? now + 5 * 24 * HOUR : null } : null,
    seenVersion: null,
    facts: { sameOpId: null, actorWasOwnerAtCall: r.chance(0.9) },
  };
}

/** Любое событие, кроме `dnc_clear` и `merge`; сложные поля — по минимуму, нужному типу. */
function genAnyEvent(r: Rng, card: CardSnapshot, now: Ms): { event: CardEvent; actor: Actor } {
  const base = { opId: `op-${r.int(1, 1e9)}` };
  const seen = card.version;
  const t = r.int(0, 18);
  const actor = r.chance(0.5) ? LEAD : OP;
  switch (t) {
    case 0: case 1: case 2: case 3: case 4: return { event: genOutcomeEvent(r, now), actor: r.chance(0.7) ? OP : LEAD };
    case 5: return { event: { ...base, type: 'close_from_menu', seenVersion: seen, kind: r.pick(['not_target', 'do_not_call'] as const), reasonCode: 'r1', alsoDncPhoneIds: [] }, actor };
    case 6: return { event: { ...base, type: 'reopen', seenVersion: seen, comment: 'c' }, actor };
    case 7: return { event: { ...base, type: 'return_due', runId: 'run-1', facts: { ownerActive: r.chance(0.5), capRemaining: r.int(0, 3) } }, actor: SYS };
    case 8: return { event: { ...base, type: 'release', seenVersion: null }, actor };
    case 9: return { event: { ...base, type: 'assign', mode: 'manual', toUserId: 'u-b', runId: null, seenVersion: null, facts: { capRemaining: r.int(0, 2) } }, actor: LEAD };
    case 10: return { event: { ...base, type: 'transfer', seenVersion: seen, toUserId: 'u-b', facts: { toUserActive: true } }, actor: LEAD };
    case 11: return { event: { ...base, type: 'no_show', bookingId: 'bk-1', facts: { hasOtherFutureBooking: r.chance(0.5) } }, actor: SYS };
    case 12: return { event: { ...base, type: 'booking_cancelled', bookingId: 'bk-1', reason: r.pick(['client', 'operator_error'] as const), createdByOpId: null, facts: { hasOtherFutureBooking: r.chance(0.5) } }, actor: SYS };
    case 13: return { event: { ...base, type: 'purchase', dealId: null, serviceTypeKey: 'svc', amountKzt: 1000 }, actor: SYS };
    case 14: return { event: { ...base, type: 'deal_lost', dealId: 'd-1', reasonCode: 'r1', softness: r.pick(['soft', 'hard'] as const), facts: { hasOtherOpenDeal: false } }, actor: SYS };
    case 15: return { event: { ...base, type: 'inbound_message', channel: r.pick(['messenger', 'call'] as const) }, actor: SYS };
    case 16: return { event: { ...base, type: 'inbound_reactivate', seenVersion: seen }, actor };
    case 17: return { event: { ...base, type: 'attended', bookingId: 'bk-1', eventDay: '2026-10-20', facts: { hasNextFutureBooking: false } }, actor: SYS };
    default: return { event: { ...base, type: 'agreed_sweep', facts: { hasFutureBooking: r.chance(0.5), hasOpenOwnerTask: r.chance(0.5) } }, actor: SYS };
  }
}

/** Копия входа без календаря (в нём функции; сам календарь без состояния). */
const copy = (i: TransitionInput): TransitionInput => ({ ...structuredClone({ ...i, calendar: undefined }), calendar: i.calendar });

const now = (r: Rng): Ms => CAL.nextCallMoment(T0 + r.int(24, 14 * 24) * HOUR);

test(`свойство: applyOutcome не мутирует вход (${CASES} случаев)`, () => {
  const r = rng(101);
  for (let i = 0; i < CASES; i++) {
    const settings = genSettings(r);
    const card = genCard(r, settings);
    const n = now(r);
    const { event, actor } = genAnyEvent(r, card, n);
    const input: TransitionInput = { card, event, actor, now: n, settings, calendar: CAL };
    const pristine = copy(input);
    const arg = copy(input);
    applyOutcome(arg);
    assert.deepStrictEqual(arg, pristine, `случай ${i}: вход изменён (${event.type})\n${JSON.stringify(input)}`);
    // Замороженная копия: мутация бросит TypeError, а не пройдёт молча.
    const frozen = copy(input);
    for (const part of [frozen.card, frozen.event, frozen.actor, frozen.settings]) deepFreeze(part);
    try {
      applyOutcome(frozen);
    } catch (e) {
      assert.fail(`случай ${i}: ${event.type} упал на замороженном входе: ${(e as Error).message}\n${JSON.stringify(input)}`);
    }
  }
});

test(`свойство: после любого события состояние из закрытого списка, версия не падает (${CASES} случаев)`, () => {
  const r = rng(102);
  for (let i = 0; i < CASES; i++) {
    const settings = genSettings(r);
    const card = genCard(r, settings);
    const n = now(r);
    const { event, actor } = genAnyEvent(r, card, n);
    const res = applyOutcome(copy({ card, event, actor, now: n, settings, calendar: CAL }));
    if (res.status === 'applied' || res.status === 'fact_only') {
      assert.ok((CARD_STATES as readonly string[]).includes(res.card.state), `случай ${i}: состояние ${res.card.state}`);
      assert.ok(res.card.version >= card.version, `случай ${i}: версия уменьшилась`);
    } else {
      assert.ok(['duplicate', 'rejected'].includes(res.status));
    }
  }
});

test(`свойство: «не звонить» необратимо без dnc_clear (${CASES} цепочек)`, () => {
  const r = rng(103);
  for (let i = 0; i < CASES; i++) {
    const settings = genSettings(r);
    let card = genCard(r, settings, 'do_not_call');
    let n = now(r);
    const trace: string[] = [];
    for (let step = 0; step < r.int(1, 6); step++) {
      const { event, actor } = genAnyEvent(r, card, n);
      trace.push(event.type === 'outcome' ? `outcome:${event.outcomeKey}` : event.type);
      const res = applyOutcome(copy({ card, event, actor, now: n, settings, calendar: CAL }));
      if (res.status === 'applied' || res.status === 'fact_only') {
        assert.equal(res.card.state, 'do_not_call', `цепочка ${i}: [${trace.join(' > ')}] вывела из do_not_call в ${res.card.state}`);
        card = res.card;
      }
      n += r.int(1, 48) * HOUR;
    }
  }
});

test(`свойство: nextCallAt — в окне звонков или null; попыток не больше maxAttempts (${CASES} случаев)`, () => {
  const r = rng(104);
  for (let i = 0; i < CASES; i++) {
    const settings = genSettings(r);
    const card = genCard(r, settings, r.pick(['new', 'retry', 'callback'] as const));
    const n = now(r);
    const event = genOutcomeEvent(r, n);
    const res = applyOutcome(copy({ card, event, actor: OP, now: n, settings, calendar: CAL }));
    if (res.status !== 'applied' && res.status !== 'fact_only') continue;
    const ctx = `случай ${i}: ${JSON.stringify({ state: card.state, attempts: card.attempts, retry: settings.retry, event })}`;
    const next = res.card.nextCallAt;
    // «Номер не работает, есть другой»: по спецификации (PROCESS 3.5 № 6) срок — «сейчас», то есть время звонка,
    // без привязки к окну. Это известное расхождение с инвариантом «срок всегда в окне звонков»; проверяем
    // сам контракт спецификации, а не окно.
    if (res.status === 'applied' && res.call?.outcomeKind === 'bad_number' && res.card.state === 'retry') {
      assert.equal(next, res.call.occurredAt, ctx);
    } else if (next !== null) {
      const okWindow = CAL.isInCallWindow(next);
      // Перезвон, назначенный человеком вне часов, допустим только с предупреждением.
      const warned = res.card.state === 'callback' && res.warnings.includes('callback_outside_work_hours');
      assert.ok(okWindow || warned, `${ctx}\nnextCallAt ${new Date(next).toISOString()} (${res.card.state}) вне окна`);
    }
    assert.ok(res.card.attempts <= settings.retry.maxAttempts, `${ctx}\nattempts ${res.card.attempts} > ${settings.retry.maxAttempts}`);
  }
});

test(`свойство: цепочка недозвонов списывает карточку ровно на maxAttempts-й попытке (${CASES} цепочек)`, () => {
  const r = rng(105);
  for (let i = 0; i < CASES; i++) {
    const settings = genSettings(r);
    let card: CardSnapshot = { ...genCard(r, settings, 'new'), lastOutcomeAt: null, ownerUserId: 'u-a' };
    let n = now(r);
    for (let k = 1; k <= settings.retry.maxAttempts; k++) {
      const event = { ...(genOutcomeEvent(r, n) as Extract<CardEvent, { type: 'outcome' }>), outcomeKey: 'no_answer', lpr: '' as const, facts: { sameOpId: null, actorWasOwnerAtCall: true }, occurredAt: n, receivedAt: n };
      const res = applyOutcome(copy({ card, event, actor: OP, now: n, settings, calendar: CAL }));
      assert.equal(res.status, 'applied', `цепочка ${i}, попытка ${k}: ${JSON.stringify(res)}`);
      if (res.status !== 'applied') return;
      assert.ok(res.card.attempts <= settings.retry.maxAttempts, `цепочка ${i}: attempts ${res.card.attempts}`);
      if (k < settings.retry.maxAttempts) {
        assert.equal(res.card.state, 'retry', `цепочка ${i}, попытка ${k}`);
        assert.ok(res.card.nextCallAt !== null && res.card.nextCallAt > n && CAL.isInCallWindow(res.card.nextCallAt), `цепочка ${i}, попытка ${k}: nextCallAt`);
      } else {
        assert.equal(res.card.state, 'written_off', `цепочка ${i}: после ${k} недозвонов`);
        assert.equal(res.card.nextCallAt, null);
      }
      card = res.card;
      n = card.nextCallAt ?? n;
    }
  }
});

test(`свойство: любое событие — новый nextCallAt в окне звонков или null (${CASES * 2} случаев)`, () => {
  const r = rng(106);
  for (let i = 0; i < CASES * 2; i++) {
    const settings = genSettings(r);
    const card = genCard(r, settings);
    const n = now(r);
    const { event, actor } = genAnyEvent(r, card, n);
    const res = applyOutcome(copy({ card, event, actor, now: n, settings, calendar: CAL }));
    if (res.status !== 'applied' && res.status !== 'fact_only') continue;
    const next = res.card.nextCallAt;
    if (next === null || next === card.nextCallAt) continue;
    // Исключения — по спецификации: «сейчас» при смене номера и перезвон человека вне часов с предупреждением.
    if (res.call?.outcomeKind === 'bad_number' || res.warnings.includes('callback_outside_work_hours')) continue;
    assert.ok(CAL.isInCallWindow(next), `случай ${i}: ${event.type} -> ${res.card.state} nextCallAt ${new Date(next).toISOString()}\n${JSON.stringify({ card: card.state, settings: settings.retry, event })}`);
  }
});
