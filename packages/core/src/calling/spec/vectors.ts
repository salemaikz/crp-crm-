// Тест-векторы машины состояний карточки обзвона (PROCESS §3.4, §3.5 № 1–31, §12).
// Тест builder: для каждого вектора `applyOutcome(v.input)` глубоко равно `v.expected`
// (см. README.md). Все данные синтетические: id вида `card-1`, `u-op-a`, номера — только id.
//
// Время — местное UTC+5 (пояс без перехода на летнее время), октябрь 2026:
// пн 19.10 … пт 23.10, сб 24.10, вс 25.10, пн 26.10 — праздничный выходной (перенос),
// вт 27.10 … пт 30.10, сб 31.10, пн 02.11. Окно звонков 09:00–18:00, рабочие дни пн–пт.

import type {
  Actor,
  AppliedResult,
  CallingSettings,
  CallRecord,
  CardSnapshot,
  CardState,
  Effects,
  FactReason,
  FactOnlyResult,
  LocalDay,
  Ms,
  OutcomeDef,
  OutcomeEvent,
  OutcomeKind,
  PhoneSnapshot,
  RejectCode,
  RejectedResult,
  StateCause,
  TaskEffect,
  TimelineEffect,
  TransitionInput,
  TransitionVector,
  UserId,
  WorkCalendar,
  Warning,
  CardEvent,
} from './types.js';
import { CALLBACK_TASK_SOURCES } from './types.js';

// ---------- Время и тестовый календарь ----------

const OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;
/** Праздничные дни тестового календаря (слой страны в пресете). */
const HOLIDAYS: ReadonlySet<LocalDay> = new Set(['2026-10-26']);

/** Местное время 'YYYY-MM-DD HH:MM' (UTC+5) → epoch-мс. */
export function at(local: string): Ms {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`bad local time: ${local}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - OFFSET_MS;
}

function dayOf(t: Ms): LocalDay {
  return new Date(t + OFFSET_MS).toISOString().slice(0, 10);
}
function minutesOf(t: Ms): number {
  const d = new Date(t + OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function isWorkday(day: LocalDay): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5 && !HOLIDAYS.has(day);
}
function nextDay(day: LocalDay): LocalDay {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Тестовый календарь: пн–пт, 26.10.2026 выходной, окно звонков [09:00, 18:00). */
export const TEST_CALENDAR: WorkCalendar = {
  callWindowStart: '09:00',
  localDay: dayOf,
  isWorkday,
  isInCallWindow(t) {
    const min = minutesOf(t);
    return isWorkday(dayOf(t)) && min >= 9 * 60 && min < 18 * 60;
  },
  nextWorkdayAt(t, hhmm) {
    let d = nextDay(dayOf(t));
    while (!isWorkday(d)) d = nextDay(d);
    return at(`${d} ${hhmm}`);
  },
  nextWorkdayTimeAfter(after, hhmm) {
    let d = dayOf(after);
    for (;;) {
      if (isWorkday(d)) {
        const c = at(`${d} ${hhmm}`);
        if (c > after) return c;
      }
      d = nextDay(d);
    }
  },
  addDays: (t, days) => t + days * DAY_MS,
};

// ---------- Настройки (тестовый пресет) ----------

function def(
  key: string,
  kind: OutcomeKind,
  req: Partial<OutcomeDef['requires']>,
  archivedAt: Ms | null = null,
): OutcomeDef {
  return {
    key,
    kind,
    requires: { lpr: false, reason: false, callbackAt: false, contact: false, agreement: false, ...req },
    archived: archivedAt !== null,
    archivedAt,
  };
}

export const TEST_SETTINGS: CallingSettings = {
  outcomes: [
    def('no_answer', 'no_answer', {}),
    def('bad_number', 'bad_number', { reason: true }),
    def('callback', 'callback', { lpr: true, callbackAt: true }),
    def('agreed', 'agreed', { lpr: true, contact: true, agreement: true }),
    def('not_interested', 'not_interested', { lpr: true, reason: true }),
    def('not_target', 'not_target', { reason: true }),
    def('do_not_call', 'do_not_call', { reason: true }),
    // Архивный итог (12.31): архивирован вт 27.10 18:00.
    def('legacy_busy', 'no_answer', {}, at('2026-10-27 18:00')),
  ],
  lprRequiredOnContact: true,
  lprNoRequiresInfo: true,
  callbackPastToleranceMin: 5,
  offlineWindowHours: 72,
  retry: { steps: ['+2h', 'nextWorkday@10:00'], maxAttempts: 3 },
  returnDays: { not_interested: 90, deal_lost_soft: 90 },
  skipLimit: 10,
  capIncludes: ['auto', 'manual', 'return'],
  noShowCallbackAt: 'nextWorkday@10:00',
  nextStepTaskAt: 'nextWorkday@10:00',
  autoNoShowWorkdays: 2,
  inboundReplyMinutes: 15,
};

const withSettings = (p: Partial<CallingSettings>): CallingSettings => ({ ...TEST_SETTINGS, ...p });

// ---------- Действующие лица ----------

const A: UserId = 'u-op-a';
const B: UserId = 'u-op-b';
const OP_A: Actor = { userId: A, kind: 'user', scope: 'own' };
const OP_B: Actor = { userId: B, kind: 'user', scope: 'own' };
const LEAD: Actor = { userId: 'u-lead', kind: 'user', scope: 'space' };
const DUTY: Actor = { userId: 'u-duty', kind: 'user', scope: 'relation' };
const CONS: Actor = { userId: 'u-cons', kind: 'user', scope: 'relation' };
const SYS: Actor = { userId: null, kind: 'system', scope: 'space' };

// ---------- Телефоны и карточки ----------

function phone(id: string, p: Partial<PhoneSnapshot> = {}): PhoneSnapshot {
  return {
    id,
    kind: 'mobile',
    isWorking: true,
    isPrimary: false,
    inStopList: false,
    sharedWithOtherClient: false,
    heldByOtherDncClient: false,
    ...p,
  };
}
const PH1 = phone('ph-1', { isPrimary: true });
const PH2 = phone('ph-2', { kind: 'landline' });
const PH1_DEAD: PhoneSnapshot = { ...PH1, isWorking: false, isPrimary: false };
const PH2_MAIN: PhoneSnapshot = { ...PH2, isPrimary: true };

/** В пуле: только что вошла из источника. */
const POOL: CardSnapshot = {
  id: 'card-1',
  clientId: 'client-1',
  ownerUserId: null,
  actingUserId: null,
  actingUntilDay: '',
  state: 'new',
  holdReason: '',
  attempts: 0,
  nextCallAt: null,
  returnAt: null,
  lpr: '',
  isTarget: '',
  lastOutcomeCode: '',
  lastOutcomeKind: '',
  lastOutcomeAt: null,
  closeReasonCode: '',
  closedAt: null,
  assignedAt: null,
  touchedInCrm: false,
  callsTotal: 0,
  connectsTotal: 0,
  noAnswerTotal: 0,
  firstConnectAt: null,
  lastConnectAt: null,
  lastTouchAt: null,
  callbackReason: '',
  callbackTouches: 0,
  nextCallPrecision: 'time',
  version: 0,
  phones: [PH1],
};

/** Новая у оператора А (выдана пн 19.10 08:00). */
const NEW_A: CardSnapshot = { ...POOL, ownerUserId: A, assignedAt: at('2026-10-19 08:00'), touchedInCrm: true, version: 1 };

/** После первого недозвона ср 28.10 10:14. */
const R1: CardSnapshot = {
  ...NEW_A,
  state: 'retry',
  attempts: 1,
  nextCallAt: at('2026-10-28 12:14'),
  lastOutcomeCode: 'no_answer',
  lastOutcomeKind: 'no_answer',
  lastOutcomeAt: at('2026-10-28 10:14'),
  callsTotal: 1,
  noAnswerTotal: 1,
  lastTouchAt: at('2026-10-28 10:14'),
  version: 2,
};

/** После второго недозвона ср 28.10 12:20. */
const R2: CardSnapshot = {
  ...R1,
  attempts: 2,
  nextCallAt: at('2026-10-29 10:00'),
  lastOutcomeAt: at('2026-10-28 12:20'),
  callsTotal: 2,
  noAnswerTotal: 2,
  lastTouchAt: at('2026-10-28 12:20'),
  version: 3,
};

/** Перезвон чт 29.10 15:30, назначен итогом чт 29.10 10:03 (ЛПР: нет). */
const CB: CardSnapshot = {
  ...R2,
  state: 'callback',
  attempts: 0,
  nextCallAt: at('2026-10-29 15:30'),
  lpr: 'no',
  callbackTouches: 1,
  lastOutcomeCode: 'callback',
  lastOutcomeKind: 'callback',
  lastOutcomeAt: at('2026-10-29 10:03'),
  callsTotal: 3,
  connectsTotal: 1,
  firstConnectAt: at('2026-10-29 10:03'),
  lastConnectAt: at('2026-10-29 10:03'),
  lastTouchAt: at('2026-10-29 10:03'),
  version: 4,
};

/** Договорились чт 29.10 15:34: запись bk-1 на групповое мероприятие чт 05.11. */
const AG: CardSnapshot = {
  ...CB,
  state: 'agreed',
  nextCallAt: null,
  callbackTouches: 0,
  lpr: 'yes',
  isTarget: 'yes',
  lastOutcomeCode: 'agreed',
  lastOutcomeKind: 'agreed',
  lastOutcomeAt: at('2026-10-29 15:34'),
  callsTotal: 4,
  connectsTotal: 2,
  lastConnectAt: at('2026-10-29 15:34'),
  lastTouchAt: at('2026-10-29 15:34'),
  version: 5,
};

/** Клиент: покупка чт 12.11 14:00. */
const CL: CardSnapshot = { ...AG, state: 'client', version: 6 };

/** «Не интересует» пт 23.10 11:00, возврат чт 21.01.2027 11:00. */
const NI: CardSnapshot = {
  ...NEW_A,
  state: 'not_interested',
  returnAt: at('2027-01-21 11:00'),
  lpr: 'yes',
  isTarget: 'yes',
  lastOutcomeCode: 'not_interested',
  lastOutcomeKind: 'not_interested',
  lastOutcomeAt: at('2026-10-23 11:00'),
  closeReasonCode: 'too_expensive',
  closedAt: at('2026-10-23 11:00'),
  callsTotal: 1,
  connectsTotal: 1,
  firstConnectAt: at('2026-10-23 11:00'),
  lastConnectAt: at('2026-10-23 11:00'),
  lastTouchAt: at('2026-10-23 11:00'),
  version: 2,
};

/** Списан чт 29.10 10:05 третьим недозвоном. */
const WO: CardSnapshot = {
  ...R2,
  state: 'written_off',
  attempts: 3,
  nextCallAt: null,
  lastOutcomeAt: at('2026-10-29 10:05'),
  closeReasonCode: 'no_answer_limit',
  closedAt: at('2026-10-29 10:05'),
  callsTotal: 3,
  noAnswerTotal: 3,
  lastTouchAt: at('2026-10-29 10:05'),
  version: 4,
};

/** «Не целевой» ср 28.10 10:40. */
const NT: CardSnapshot = {
  ...NEW_A,
  state: 'not_target',
  isTarget: 'no',
  lastOutcomeCode: 'not_target',
  lastOutcomeKind: 'not_target',
  lastOutcomeAt: at('2026-10-28 10:40'),
  closeReasonCode: 'company_closed',
  closedAt: at('2026-10-28 10:40'),
  callsTotal: 1,
  connectsTotal: 1,
  firstConnectAt: at('2026-10-28 10:40'),
  lastConnectAt: at('2026-10-28 10:40'),
  lastTouchAt: at('2026-10-28 10:40'),
  version: 2,
};

/** «Не звонить» чт 22.10 12:00; оба номера в стоп-листе, ph-2 держит и другой клиент. */
const DNC: CardSnapshot = {
  ...NEW_A,
  state: 'do_not_call',
  lastOutcomeCode: 'do_not_call',
  lastOutcomeKind: 'do_not_call',
  lastOutcomeAt: at('2026-10-22 12:00'),
  closeReasonCode: 'asked_not_to_call',
  closedAt: at('2026-10-22 12:00'),
  callsTotal: 1,
  connectsTotal: 1,
  firstConnectAt: at('2026-10-22 12:00'),
  lastConnectAt: at('2026-10-22 12:00'),
  lastTouchAt: at('2026-10-22 12:00'),
  phones: [{ ...PH1, inStopList: true }, phone('ph-2', { kind: 'landline', inStopList: true, heldByOtherDncClient: true })],
  version: 2,
};

/** Перезвон после неявки на bk-1 (результат r16a). */
const NS: CardSnapshot = { ...AG, state: 'callback', nextCallAt: at('2026-11-06 10:00'), version: 6 };

// ---------- Помощники для входа и выхода ----------

function inp(
  card: CardSnapshot | null,
  event: CardEvent,
  actor: Actor,
  now: Ms,
  settings: CallingSettings = TEST_SETTINGS,
): TransitionInput {
  return { card, event, actor, now, settings, calendar: TEST_CALENDAR };
}

function oc(p: Partial<OutcomeEvent> & Pick<OutcomeEvent, 'opId' | 'outcomeKey' | 'occurredAt'>): OutcomeEvent {
  return {
    type: 'outcome',
    via: 'ui',
    receivedAt: p.occurredAt,
    phoneId: 'ph-1',
    reasonCode: '',
    hasNote: false,
    lpr: '',
    lprInfoFilled: false,
    callbackAt: null,
    markTarget: false,
    alsoDncPhoneIds: [],
    agreement: null,
    seenVersion: null,
    facts: { sameOpId: null, actorWasOwnerAtCall: true },
    ...p,
  };
}

function fx(p: Partial<Effects> = {}): Effects {
  return {
    tasks: [],
    deals: [],
    bookings: [],
    stopList: [],
    assignLog: [],
    notifications: [],
    timeline: [],
    audit: [],
    skips: [],
    ...p,
  };
}

function ok(card: CardSnapshot, effects: Effects = fx(), call: CallRecord | null = null, warnings: Warning[] = []): AppliedResult {
  return { status: 'applied', card, call, effects, warnings };
}

function fact(
  factReason: 'owner_changed' | 'stale',
  card: CardSnapshot,
  call: CallRecord,
  effects: Effects,
): FactOnlyResult {
  return { status: 'fact_only', factReason, card, call, effects, warnings: [] };
}

function reject(error: RejectCode, field: string | null = null): RejectedResult {
  return { status: 'rejected', error, field };
}

/** Строка `calls` из события итога. */
function rec(
  e: OutcomeEvent,
  kind: OutcomeKind,
  userId: UserId | null,
  ownerAtCall: UserId | null,
  p: Partial<CallRecord> = {},
): CallRecord {
  return {
    id: e.opId,
    outcomeCode: e.outcomeKey,
    outcomeKind: kind,
    reasonCode: e.reasonCode,
    lpr: e.lpr,
    callbackAt: e.callbackAt,
    callbackPrecision: e.callbackPrecision ?? 'time',
    phoneId: e.phoneId,
    via: e.via,
    applied: 'applied',
    factReason: '',
    occurredAt: e.occurredAt,
    receivedAt: e.receivedAt,
    userId,
    ownerUserIdAtCall: ownerAtCall,
    ...p,
  };
}

function tlCall(
  callId: string,
  t: Ms,
  actorId: UserId | null,
  kind: OutcomeKind,
  from: CardState,
  to: CardState,
  factReason: FactReason = '',
): TimelineEffect {
  return { kind: 'call', at: t, actorId, ref: { type: 'call', id: callId }, data: { outcomeKind: kind, fromState: from, toState: to, factReason } };
}

function tlState(t: Ms, actorId: UserId | null, from: CardState, to: CardState, cause: StateCause): TimelineEffect {
  return { kind: 'card.state', at: t, actorId, ref: null, data: { fromState: from, toState: to, cause } };
}

function tlPhone(kind: 'phone.not_working' | 'phone.primary', t: Ms, actorId: UserId | null, phoneId: string): TimelineEffect {
  return { kind, at: t, actorId, ref: null, data: { phoneId } };
}

const closeCallbackTasks: TaskEffect = { op: 'close', sources: [...CALLBACK_TASK_SOURCES] };
const closeAllTasks: TaskEffect = { op: 'close', sources: 'all' };

function callbackTask(opId: string, owner: UserId, dueAt: Ms): TaskEffect {
  return { op: 'create', source: 'callback', kind: 'call', assignee: { user: owner }, dueAt, sourceKey: `callback:${opId}` };
}

/** Настройки воронки v2 (pipeline-v2 §4): группы причин, обязательность причины перезвона, шаги срока. */
export const SETTINGS_V2: CallingSettings = withSettings({
  reasons: {
    callback: [
      { code: 'think', archived: false, manual: true },
      { code: 'old_think', archived: true, manual: true },
      { code: 'repeat_sale', archived: false, manual: false, system: 'client_return' },
      { code: 'no_show_group', archived: false, manual: false, system: 'no_show', eventTypes: ['group'] },
    ],
    not_interested: [{ code: 'too_expensive', archived: false, manual: true }],
    deal_lost: [
      { code: 'other', archived: false, manual: true },
      { code: 'no_show_unreachable', archived: false, manual: false, system: 'write_off' },
    ],
  },
  callbackReason: { required: true },
  callbackSchedule: { steps: ['+3d', '+7d', '+14d'] },
});

// ---------- Векторы ----------

/** Повторяющиеся события. */
const E04A = oc({ opId: 'op-r04a', outcomeKey: 'no_answer', occurredAt: at('2026-10-28 10:14') });
const E04B = oc({ opId: 'op-r04b', outcomeKey: 'no_answer', occurredAt: at('2026-10-28 12:20') });
const E04C = oc({ opId: 'op-r04c', outcomeKey: 'no_answer', occurredAt: at('2026-10-20 16:30') });
const E04D = oc({ opId: 'op-r04d', outcomeKey: 'no_answer', occurredAt: at('2026-10-23 17:00') });
const E04E = oc({ opId: 'op-r04e', outcomeKey: 'no_answer', occurredAt: at('2026-10-20 16:00') });
const E04F = oc({ opId: 'op-r04f', outcomeKey: 'no_answer', occurredAt: at('2026-10-24 12:00') });
const E04G = oc({ opId: 'op-r04g', outcomeKey: 'no_answer', occurredAt: at('2026-10-20 06:30') });
const E04H = oc({ opId: 'op-r04h', outcomeKey: 'no_answer', occurredAt: at('2026-10-29 15:34') });
const E05A = oc({ opId: 'op-r05a', outcomeKey: 'no_answer', occurredAt: at('2026-10-29 10:05') });
const E05B = oc({ opId: 'op-r05b', outcomeKey: 'no_answer', occurredAt: at('2026-10-28 10:14') });
const E06A = oc({ opId: 'op-r06a', outcomeKey: 'bad_number', reasonCode: 'not_exists', occurredAt: at('2026-10-28 10:30') });
const E06B = oc({ opId: 'op-r06b', outcomeKey: 'bad_number', reasonCode: 'not_exists', occurredAt: at('2026-10-29 15:34') });
const E06C = oc({ opId: 'op-r06c', outcomeKey: 'bad_number', reasonCode: 'unrelated', occurredAt: at('2026-10-29 09:40') });
const E07A = oc({ opId: 'op-r07a', outcomeKey: 'bad_number', reasonCode: 'not_exists', occurredAt: at('2026-10-28 10:30') });
const E07B = oc({ opId: 'op-r07b', outcomeKey: 'bad_number', reasonCode: 'not_exists', occurredAt: at('2026-10-28 10:30') });
const E08A = oc({
  opId: 'op-r08a',
  outcomeKey: 'callback',
  occurredAt: at('2026-10-29 10:03'),
  lpr: 'no',
  lprInfoFilled: true,
  callbackAt: at('2026-10-29 15:30'),
});
const E08B = oc({
  opId: 'op-r08b',
  outcomeKey: 'callback',
  occurredAt: at('2026-10-29 15:31'),
  lpr: 'yes',
  markTarget: true,
  callbackAt: at('2026-10-30 11:00'),
});
const E08C = oc({ opId: 'op-r08c', outcomeKey: 'callback', occurredAt: at('2026-10-29 17:50'), lpr: 'yes', callbackAt: at('2026-10-29 20:00') });
const E08D = oc({ opId: 'op-r08d', outcomeKey: 'callback', occurredAt: at('2026-10-30 16:00'), lpr: 'yes', callbackAt: at('2026-10-31 11:00') });
const E08F = oc({ opId: 'op-r08f', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', callbackAt: at('2026-10-29 09:59') });
const E08I = oc({ opId: 'op-r08i', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'no', hasNote: true, callbackAt: at('2026-10-29 15:30') });
const E09A = oc({
  opId: 'op-r09a',
  outcomeKey: 'agreed',
  occurredAt: at('2026-10-29 15:34'),
  lpr: 'yes',
  agreement: { contactId: 'contact-1', bookingId: 'bk-1', agreedDueAt: null },
});
const E09B = oc({
  opId: 'op-r09b',
  outcomeKey: 'agreed',
  occurredAt: at('2026-10-28 11:00'),
  lpr: 'yes',
  agreement: { contactId: 'contact-1', bookingId: null, agreedDueAt: at('2026-11-02 11:00') },
});
const E10A = oc({ opId: 'op-r10a', outcomeKey: 'not_interested', occurredAt: at('2026-10-23 11:00'), lpr: 'yes', reasonCode: 'too_expensive' });
const E10C = oc({ opId: 'op-r10c', outcomeKey: 'not_interested', occurredAt: at('2026-10-23 11:00'), lpr: 'yes', reasonCode: 'too_expensive' });
const E11A = oc({ opId: 'op-r11a', outcomeKey: 'not_target', occurredAt: at('2026-10-28 10:40'), reasonCode: 'company_closed' });
const E12A = oc({
  opId: 'op-r12a',
  outcomeKey: 'do_not_call',
  occurredAt: at('2026-10-29 15:34'),
  reasonCode: 'asked_not_to_call',
  alsoDncPhoneIds: ['ph-2', 'ph-3'],
});
const E26A = oc({ opId: 'op-r26a', outcomeKey: 'callback', occurredAt: at('2026-10-28 12:22'), lpr: 'yes', callbackAt: at('2026-10-29 11:00') });

const E121A = oc({
  opId: 'op-e12_1a',
  outcomeKey: 'no_answer',
  via: 'offline',
  occurredAt: at('2026-10-28 12:10'),
  receivedAt: at('2026-10-28 12:25'),
});
const E121B = oc({
  opId: 'op-e12_1b',
  outcomeKey: 'do_not_call',
  via: 'offline',
  reasonCode: 'asked_not_to_call',
  occurredAt: at('2026-10-28 12:10'),
  receivedAt: at('2026-10-28 12:25'),
});
const E123A = oc({
  opId: 'op-e12_3a',
  outcomeKey: 'no_answer',
  via: 'offline',
  occurredAt: at('2026-10-28 10:14'),
  receivedAt: at('2026-10-28 13:20'),
});
const E123B = oc({
  opId: 'op-e12_3b',
  outcomeKey: 'no_answer',
  via: 'offline',
  occurredAt: at('2026-10-19 10:00'),
  receivedAt: at('2026-10-23 10:00'),
});
const E123C = oc({
  opId: 'op-e12_3c',
  outcomeKey: 'no_answer',
  occurredAt: at('2026-10-28 10:30'),
  receivedAt: at('2026-10-28 10:20'),
});
const E124A = oc({ opId: 'op-e12_4a', outcomeKey: 'no_answer', via: 'offline', occurredAt: at('2026-10-28 12:20'), seenVersion: 5 });
const E124B = oc({
  opId: 'op-e12_4b',
  outcomeKey: 'not_interested',
  via: 'offline',
  occurredAt: at('2026-10-29 16:00'),
  receivedAt: at('2026-10-29 16:30'),
  lpr: 'yes',
  reasonCode: 'no_need',
});
const E125A = oc({
  opId: 'op-e12_5a',
  outcomeKey: 'no_answer',
  via: 'offline',
  occurredAt: at('2026-10-29 15:34'),
  receivedAt: at('2026-10-29 15:40'),
});
const E129 = oc({
  opId: 'op-e12_9',
  outcomeKey: 'callback',
  via: 'offline',
  occurredAt: at('2026-10-28 10:00'),
  receivedAt: at('2026-10-28 13:00'),
  lpr: 'yes',
  callbackAt: at('2026-10-28 11:00'),
});
const E1231A = oc({ opId: 'op-e12_31a', outcomeKey: 'legacy_busy', occurredAt: at('2026-10-28 10:00') });
const E_ACT = oc({ opId: 'op-e_acting', outcomeKey: 'no_answer', occurredAt: at('2026-10-28 12:20') });

export const VECTORS: TransitionVector[] = [
  // ===== № 1. Вход из источника =====
  {
    id: 'r01a',
    refs: ['3.5 №1'],
    title: 'Вход из источника: карточка «Новая» без владельца, счётчики 0, лента «Создан»',
    input: inp(
      null,
      { type: 'enter', opId: 'op-r01a', cardId: 'card-1', clientId: 'client-1', phones: [PH1], sourceKey: 'api_feed', holdReason: '' },
      SYS,
      at('2026-10-28 02:10'),
    ),
    expected: ok(
      POOL,
      fx({ timeline: [{ kind: 'card.created', at: at('2026-10-28 02:10'), actorId: null, ref: null, data: { sourceKey: 'api_feed' } }] }),
    ),
  },
  {
    id: 'r01b',
    refs: ['3.5 №1'],
    title: 'Вход для уже существующей карточки — недопустимый переход',
    input: inp(
      NEW_A,
      { type: 'enter', opId: 'op-r01b', cardId: 'card-1', clientId: 'client-1', phones: [PH1], sourceKey: 'api_feed', holdReason: '' },
      SYS,
      at('2026-10-28 02:10'),
    ),
    expected: reject('invalid_transition'),
  },

  // ===== № 2. Раздача =====
  {
    id: 'r02a',
    refs: ['3.5 №2', '7.3'],
    title: 'Авто-раздача: владелец назначен, выдача входит в лимит, одно сводное уведомление на прогон',
    input: inp(
      POOL,
      { type: 'assign', opId: 'op-r02a', mode: 'auto', toUserId: A, runId: 'run-1028-0800', seenVersion: null, facts: { capRemaining: 29 } },
      SYS,
      at('2026-10-28 08:00'),
    ),
    expected: ok(
      { ...POOL, ownerUserId: A, assignedAt: at('2026-10-28 08:00'), version: 1 },
      fx({
        assignLog: [{ kind: 'auto', fromUserId: null, toUserId: A, countsToCap: true }],
        notifications: [{ kind: 'cards_assigned', to: { user: A }, dedupeKey: 'assign:run-1028-0800:u-op-a' }],
        timeline: [{ kind: 'card.assigned', at: at('2026-10-28 08:00'), actorId: null, ref: null, data: { toUserId: A, mode: 'auto' } }],
      }),
    ),
  },
  {
    id: 'r02b',
    refs: ['3.5 №2', '7.3'],
    title: 'Раздача при исчерпанном лимите дня отклоняется',
    input: inp(
      POOL,
      { type: 'assign', opId: 'op-r02b', mode: 'manual', toUserId: A, runId: null, seenVersion: 0, facts: { capRemaining: 0 } },
      LEAD,
      at('2026-10-28 15:00'),
    ),
    expected: reject('cap_exhausted'),
  },

  // ===== № 3. Вернуть в пул =====
  {
    id: 'r03a',
    refs: ['3.5 №3', '7.3'],
    title: 'Вернуть в пул нетронутую новую: владелец снят, лимит не возвращается',
    input: inp(NEW_A, { type: 'release', opId: 'op-r03a', seenVersion: 1 }, LEAD, at('2026-10-28 11:00')),
    expected: ok(
      { ...NEW_A, ownerUserId: null, assignedAt: null, version: 2 },
      fx({
        assignLog: [{ kind: 'release', fromUserId: A, toUserId: null, countsToCap: false }],
        timeline: [{ kind: 'card.released', at: at('2026-10-28 11:00'), actorId: 'u-lead', ref: null, data: { fromUserId: A } }],
      }),
    ),
  },
  {
    id: 'r03b',
    refs: ['3.5 №3'],
    title: 'Вернуть в пул карточку со звонками нельзя',
    input: inp(R1, { type: 'release', opId: 'op-r03b', seenVersion: 2 }, LEAD, at('2026-10-28 11:00')),
    expected: reject('invalid_transition'),
  },
  {
    id: 'r03c',
    refs: ['3.5 №3', '3.5 (версия)', '12.1'],
    title: 'Ручное действие с устаревшей версией — «карточка изменилась»',
    input: inp(NEW_A, { type: 'release', opId: 'op-r03c', seenVersion: 0 }, LEAD, at('2026-10-28 11:00')),
    expected: reject('version_conflict'),
  },
  {
    id: 'r03d',
    refs: ['3.5 №3', '12.14'],
    title: 'Раздача и возврат в пул не делают карточку «тронутой в CRM»: дозагрузка таблицы обновит её состояние (D-145)',
    input: inp({ ...NEW_A, touchedInCrm: false }, { type: 'release', opId: 'op-r03d', seenVersion: 1 }, LEAD, at('2026-10-28 11:00')),
    expected: ok(
      { ...NEW_A, touchedInCrm: false, ownerUserId: null, assignedAt: null, version: 2 },
      fx({
        assignLog: [{ kind: 'release', fromUserId: A, toUserId: null, countsToCap: false }],
        timeline: [{ kind: 'card.released', at: at('2026-10-28 11:00'), actorId: 'u-lead', ref: null, data: { fromUserId: A } }],
      }),
    ),
  },

  // ===== № 4. Не берёт, попытка < N =====
  {
    id: 'r04a',
    refs: ['3.5 №4', '3.4', '2.10'],
    title: 'Первый недозвон ср 10:14 → повтор через 2 часа, 12:14',
    input: inp(NEW_A, E04A, OP_A, E04A.receivedAt),
    expected: ok(R1, fx({ timeline: [tlCall('op-r04a', at('2026-10-28 10:14'), A, 'no_answer', 'new', 'retry')] }), rec(E04A, 'no_answer', A, A)),
  },
  {
    id: 'r04b',
    refs: ['3.5 №4', '3.4', '2.10'],
    title: 'Второй недозвон ср 12:20 → следующий рабочий день 10:00 (чт 29.10)',
    input: inp(R1, E04B, OP_A, E04B.receivedAt),
    expected: ok(R2, fx({ timeline: [tlCall('op-r04b', at('2026-10-28 12:20'), A, 'no_answer', 'retry', 'retry')] }), rec(E04B, 'no_answer', A, A)),
  },
  {
    id: 'r04c',
    refs: ['3.5 №4', '3.4'],
    title: 'Первый недозвон вт 16:30: +2 ч = 18:30 вне окна → ср 10:00',
    input: inp(NEW_A, E04C, OP_A, E04C.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-21 10:00'),
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-20 16:30'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-20 16:30'),
        version: 2,
      },
      fx({ timeline: [tlCall('op-r04c', at('2026-10-20 16:30'), A, 'no_answer', 'new', 'retry')] }),
      rec(E04C, 'no_answer', A, A),
    ),
  },
  {
    id: 'r04d',
    refs: ['3.5 №4', '3.4'],
    title: 'Второй недозвон пт 23.10 17:00 → вт 27.10 10:00 (25.10 воскресенье, 26.10 праздничный выходной)',
    input: inp(
      {
        ...R1,
        nextCallAt: at('2026-10-23 15:00'),
        lastOutcomeAt: at('2026-10-23 13:00'),
        lastTouchAt: at('2026-10-23 13:00'),
      },
      E04D,
      OP_A,
      E04D.receivedAt,
    ),
    expected: ok(
      {
        ...R1,
        attempts: 2,
        nextCallAt: at('2026-10-27 10:00'),
        lastOutcomeAt: at('2026-10-23 17:00'),
        callsTotal: 2,
        noAnswerTotal: 2,
        lastTouchAt: at('2026-10-23 17:00'),
        version: 3,
      },
      fx({ timeline: [tlCall('op-r04d', at('2026-10-23 17:00'), A, 'no_answer', 'retry', 'retry')] }),
      rec(E04D, 'no_answer', A, A),
    ),
  },
  {
    id: 'r04e',
    refs: ['3.5 №4', '3.4'],
    title: 'Граница окна: недозвон вт 16:00, +2 ч = 18:00 — конец окна не входит → ср 10:00',
    input: inp(NEW_A, E04E, OP_A, E04E.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-21 10:00'),
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-20 16:00'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-20 16:00'),
        version: 2,
      },
      fx({ timeline: [tlCall('op-r04e', at('2026-10-20 16:00'), A, 'no_answer', 'new', 'retry')] }),
      rec(E04E, 'no_answer', A, A),
    ),
  },
  {
    id: 'r04f',
    refs: ['3.5 №4', '3.4'],
    title: 'Недозвон в субботу 24.10 12:00: +2 ч в выходной → первый рабочий день 10:00 — вт 27.10',
    input: inp(NEW_A, E04F, OP_A, E04F.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-27 10:00'),
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-24 12:00'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-24 12:00'),
        version: 2,
      },
      fx({ timeline: [tlCall('op-r04f', at('2026-10-24 12:00'), A, 'no_answer', 'new', 'retry')] }),
      rec(E04F, 'no_answer', A, A),
    ),
  },
  {
    id: 'r04g',
    refs: ['3.5 №4', '3.4'],
    title: 'Ранний недозвон вт 06:30: +2 ч = 08:30 до окна → ближайшие 10:00 рабочего дня, вт 10:00',
    input: inp(NEW_A, E04G, OP_A, E04G.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-20 10:00'),
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-20 06:30'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-20 06:30'),
        version: 2,
      },
      fx({ timeline: [tlCall('op-r04g', at('2026-10-20 06:30'), A, 'no_answer', 'new', 'retry')] }),
      rec(E04G, 'no_answer', A, A),
    ),
  },
  {
    id: 'r04h',
    refs: ['3.5 №4', '3.4', 'D-050'],
    title: 'Не ответили на договорённый перезвон: снова 3 попытки, повтор через 2 ч, задача-перезвон закрыта',
    input: inp(CB, E04H, OP_A, E04H.receivedAt),
    expected: ok(
      {
        ...CB,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-29 17:34'),
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-29 15:34'),
        callsTotal: 4,
        noAnswerTotal: 3,
        lastTouchAt: at('2026-10-29 15:34'),
        version: 5,
      },
      fx({ tasks: [closeCallbackTasks], timeline: [tlCall('op-r04h', at('2026-10-29 15:34'), A, 'no_answer', 'callback', 'retry')] }),
      rec(E04H, 'no_answer', A, A),
    ),
  },

  // ===== № 5. Не берёт, попытка = N =====
  {
    id: 'r05a',
    refs: ['3.5 №5', '3.4', '2.9'],
    title: 'Третий недозвон подряд → «Списан», причина «N недозвонов»',
    input: inp(R2, E05A, OP_A, E05A.receivedAt),
    expected: ok(WO, fx({ tasks: [closeAllTasks], deals: [{ op: 'lose_open', reasonGroup: 'deal_lost', reasonCode: 'other' }], timeline: [tlCall('op-r05a', at('2026-10-29 10:05'), A, 'no_answer', 'retry', 'written_off')] }), rec(E05A, 'no_answer', A, A)),
  },
  {
    id: 'r05b',
    refs: ['3.5 №5', 'CONFIG 6.6'],
    title: 'Настройка maxAttempts = 1: первый же недозвон из «Новой» списывает',
    input: inp(NEW_A, E05B, OP_A, E05B.receivedAt, withSettings({ retry: { steps: [], maxAttempts: 1 } })),
    expected: ok(
      {
        ...NEW_A,
        state: 'written_off',
        attempts: 1,
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-28 10:14'),
        closeReasonCode: 'no_answer_limit',
        closedAt: at('2026-10-28 10:14'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-28 10:14'),
        version: 2,
      },
      fx({ tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'deal_lost', reasonCode: 'other' }], timeline: [tlCall('op-r05b', at('2026-10-28 10:14'), A, 'no_answer', 'new', 'written_off')] }),
      rec(E05B, 'no_answer', A, A),
    ),
  },

  // ===== № 6. Номер не работает, есть другой рабочий =====
  {
    id: 'r06a',
    refs: ['3.5 №6', 'D-037'],
    title: 'Номер не работает, есть второй: номер нерабочий, второй основной, «Недозвон» сейчас, попытка не тратится',
    input: inp({ ...NEW_A, phones: [PH1, PH2] }, E06A, OP_A, E06A.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        nextCallAt: at('2026-10-28 10:30'),
        lastOutcomeCode: 'bad_number',
        lastOutcomeKind: 'bad_number',
        lastOutcomeAt: at('2026-10-28 10:30'),
        callsTotal: 1,
        lastTouchAt: at('2026-10-28 10:30'),
        phones: [PH1_DEAD, PH2_MAIN],
        version: 2,
      },
      fx({
        timeline: [
          tlCall('op-r06a', at('2026-10-28 10:30'), A, 'bad_number', 'new', 'retry'),
          tlPhone('phone.not_working', at('2026-10-28 10:30'), A, 'ph-1'),
          tlPhone('phone.primary', at('2026-10-28 10:30'), A, 'ph-2'),
        ],
      }),
      rec(E06A, 'bad_number', A, A),
    ),
  },
  {
    id: 'r06b',
    refs: ['3.5 №6', 'D-050'],
    title: 'Номер не работает из «Перезвона»: «Недозвон» сейчас по другому номеру, задача-перезвон закрыта',
    input: inp({ ...CB, phones: [PH1, PH2] }, E06B, OP_A, E06B.receivedAt),
    expected: ok(
      {
        ...CB,
        state: 'retry',
        nextCallAt: at('2026-10-29 15:34'),
        lastOutcomeCode: 'bad_number',
        lastOutcomeKind: 'bad_number',
        lastOutcomeAt: at('2026-10-29 15:34'),
        callsTotal: 4,
        lastTouchAt: at('2026-10-29 15:34'),
        phones: [PH1_DEAD, PH2_MAIN],
        version: 5,
      },
      fx({
        tasks: [closeCallbackTasks],
        timeline: [
          tlCall('op-r06b', at('2026-10-29 15:34'), A, 'bad_number', 'callback', 'retry'),
          tlPhone('phone.not_working', at('2026-10-29 15:34'), A, 'ph-1'),
          tlPhone('phone.primary', at('2026-10-29 15:34'), A, 'ph-2'),
        ],
      }),
      rec(E06B, 'bad_number', A, A),
    ),
  },
  {
    id: 'r06c',
    refs: ['3.5 №6', '3.4'],
    title: 'Номер не работает на второй попытке: попытки остаются 2',
    input: inp({ ...R2, phones: [PH1, PH2] }, E06C, OP_A, E06C.receivedAt),
    expected: ok(
      {
        ...R2,
        nextCallAt: at('2026-10-29 09:40'),
        lastOutcomeCode: 'bad_number',
        lastOutcomeKind: 'bad_number',
        lastOutcomeAt: at('2026-10-29 09:40'),
        callsTotal: 3,
        lastTouchAt: at('2026-10-29 09:40'),
        phones: [PH1_DEAD, PH2_MAIN],
        version: 4,
      },
      fx({
        timeline: [
          tlCall('op-r06c', at('2026-10-29 09:40'), A, 'bad_number', 'retry', 'retry'),
          tlPhone('phone.not_working', at('2026-10-29 09:40'), A, 'ph-1'),
          tlPhone('phone.primary', at('2026-10-29 09:40'), A, 'ph-2'),
        ],
      }),
      rec(E06C, 'bad_number', A, A),
    ),
  },

  // ===== № 7. Номер не работает, рабочих нет =====
  {
    id: 'r07a',
    refs: ['3.5 №7', '2.6'],
    title: 'Номер не работает, другого нет → «Списан», причина «Нет рабочего номера»',
    input: inp(NEW_A, E07A, OP_A, E07A.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'written_off',
        lastOutcomeCode: 'bad_number',
        lastOutcomeKind: 'bad_number',
        lastOutcomeAt: at('2026-10-28 10:30'),
        closeReasonCode: 'no_working_phone',
        closedAt: at('2026-10-28 10:30'),
        callsTotal: 1,
        lastTouchAt: at('2026-10-28 10:30'),
        phones: [PH1_DEAD],
        version: 2,
      },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'deal_lost', reasonCode: 'other' }],
        timeline: [
          tlCall('op-r07a', at('2026-10-28 10:30'), A, 'bad_number', 'new', 'written_off'),
          tlPhone('phone.not_working', at('2026-10-28 10:30'), A, 'ph-1'),
        ],
      }),
      rec(E07A, 'bad_number', A, A),
    ),
  },
  {
    id: 'r07b',
    refs: ['3.5 №7', '12.32'],
    title: 'Второй номер есть, но в стоп-листе — рабочих нет → «Списан»',
    input: inp({ ...NEW_A, phones: [PH1, { ...PH2, inStopList: true }] }, E07B, OP_A, E07B.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'written_off',
        lastOutcomeCode: 'bad_number',
        lastOutcomeKind: 'bad_number',
        lastOutcomeAt: at('2026-10-28 10:30'),
        closeReasonCode: 'no_working_phone',
        closedAt: at('2026-10-28 10:30'),
        callsTotal: 1,
        lastTouchAt: at('2026-10-28 10:30'),
        phones: [PH1_DEAD, { ...PH2, inStopList: true }],
        version: 2,
      },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'deal_lost', reasonCode: 'other' }],
        timeline: [
          tlCall('op-r07b', at('2026-10-28 10:30'), A, 'bad_number', 'new', 'written_off'),
          tlPhone('phone.not_working', at('2026-10-28 10:30'), A, 'ph-1'),
        ],
      }),
      rec(E07B, 'bad_number', A, A),
    ),
  },
  {
    id: 'r07c',
    refs: ['3.5 №7', '3.2'],
    title: '«Номер не работает» без причины отклоняется',
    input: inp(NEW_A, oc({ opId: 'op-r07c', outcomeKey: 'bad_number', occurredAt: at('2026-10-28 10:30') }), OP_A, at('2026-10-28 10:30')),
    expected: reject('reason_required', 'reasonCode'),
  },
  {
    id: 'r07d',
    refs: ['3.5 №6–7'],
    title: '«Номер не работает» без номера разговора отклоняется',
    input: inp(
      NEW_A,
      oc({ opId: 'op-r07d', outcomeKey: 'bad_number', reasonCode: 'not_exists', phoneId: null, occurredAt: at('2026-10-28 10:30') }),
      OP_A,
      at('2026-10-28 10:30'),
    ),
    expected: reject('phone_required', 'phoneId'),
  },

  // ===== № 8. Перезвонить =====
  {
    id: 'r08a',
    refs: ['3.5 №8', '2.10', 'D-050'],
    title: 'Дозвон до секретаря, ЛПР: нет + данные ЛПР, перезвон чт 15:30: попытки 0, задача-перезвон',
    input: inp(R2, E08A, OP_A, E08A.receivedAt),
    expected: ok(
      CB,
      fx({
        tasks: [callbackTask('op-r08a', A, at('2026-10-29 15:30'))],
        timeline: [tlCall('op-r08a', at('2026-10-29 10:03'), A, 'callback', 'retry', 'callback')],
      }),
      rec(E08A, 'callback', A, A),
    ),
  },
  {
    id: 'r08b',
    refs: ['3.5 №8', '2.6', 'D-036'],
    title: 'Перенос перезвона: старая задача закрыта, новая создана; чип «Целевой» ставит «да»',
    input: inp(CB, E08B, OP_A, E08B.receivedAt),
    expected: ok(
      {
        ...CB,
        nextCallAt: at('2026-10-30 11:00'),
        callbackTouches: 2,
        lpr: 'yes',
        isTarget: 'yes',
        lastOutcomeAt: at('2026-10-29 15:31'),
        callsTotal: 4,
        connectsTotal: 2,
        lastConnectAt: at('2026-10-29 15:31'),
        lastTouchAt: at('2026-10-29 15:31'),
        version: 5,
      },
      fx({
        tasks: [closeCallbackTasks, callbackTask('op-r08b', A, at('2026-10-30 11:00'))],
        timeline: [tlCall('op-r08b', at('2026-10-29 15:31'), A, 'callback', 'callback', 'callback')],
      }),
      rec(E08B, 'callback', A, A),
    ),
  },
  {
    id: 'r08c',
    refs: ['3.5 №8', '12.10'],
    title: 'Перезвон на 20:00 (вне рабочего времени): разрешён, срок не сдвигается, предупреждение',
    input: inp(NEW_A, E08C, OP_A, E08C.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        callbackTouches: 1,
        nextCallAt: at('2026-10-29 20:00'),
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 17:50'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-29 17:50'),
        lastConnectAt: at('2026-10-29 17:50'),
        lastTouchAt: at('2026-10-29 17:50'),
        version: 2,
      },
      fx({
        tasks: [callbackTask('op-r08c', A, at('2026-10-29 20:00'))],
        timeline: [tlCall('op-r08c', at('2026-10-29 17:50'), A, 'callback', 'new', 'callback')],
      }),
      rec(E08C, 'callback', A, A),
      ['callback_outside_work_hours'],
    ),
  },
  {
    id: 'r08d',
    refs: ['3.5 №8', '12.10'],
    title: 'Перезвон на субботу 31.10 (клиент просил): разрешён с предупреждением',
    input: inp(NEW_A, E08D, OP_A, E08D.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        callbackTouches: 1,
        nextCallAt: at('2026-10-31 11:00'),
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-30 16:00'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-30 16:00'),
        lastConnectAt: at('2026-10-30 16:00'),
        lastTouchAt: at('2026-10-30 16:00'),
        version: 2,
      },
      fx({
        tasks: [callbackTask('op-r08d', A, at('2026-10-31 11:00'))],
        timeline: [tlCall('op-r08d', at('2026-10-30 16:00'), A, 'callback', 'new', 'callback')],
      }),
      rec(E08D, 'callback', A, A),
      ['callback_outside_work_hours'],
    ),
  },
  {
    id: 'r08e',
    refs: ['3.5 №8', '12.9'],
    title: 'Перезвон в прошлое (13 минут до звонка) отклоняется',
    input: inp(
      NEW_A,
      oc({ opId: 'op-r08e', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', callbackAt: at('2026-10-29 09:50') }),
      OP_A,
      at('2026-10-29 10:03'),
    ),
    expected: reject('callback_in_past', 'callbackAt'),
  },
  {
    id: 'r08f',
    refs: ['3.5 №8', '12.9'],
    title: 'Перезвон на 4 минуты раньше звонка — в пределах допуска 5 минут, принят',
    input: inp(NEW_A, E08F, OP_A, E08F.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        callbackTouches: 1,
        nextCallAt: at('2026-10-29 09:59'),
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 10:03'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-29 10:03'),
        lastConnectAt: at('2026-10-29 10:03'),
        lastTouchAt: at('2026-10-29 10:03'),
        version: 2,
      },
      fx({
        tasks: [callbackTask('op-r08f', A, at('2026-10-29 09:59'))],
        timeline: [tlCall('op-r08f', at('2026-10-29 10:03'), A, 'callback', 'new', 'callback')],
      }),
      rec(E08F, 'callback', A, A),
    ),
  },
  {
    id: 'r08g',
    refs: ['3.5 №8', '2.6'],
    title: 'Перезвон без отметки ЛПР отклоняется',
    input: inp(
      NEW_A,
      oc({ opId: 'op-r08g', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), callbackAt: at('2026-10-29 15:30') }),
      OP_A,
      at('2026-10-29 10:03'),
    ),
    expected: reject('lpr_required', 'lpr'),
  },
  {
    id: 'r08h',
    refs: ['3.5 №8', '2.6'],
    title: '«ЛПР: нет» без данных ЛПР и без заметки отклоняется',
    input: inp(
      NEW_A,
      oc({ opId: 'op-r08h', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'no', callbackAt: at('2026-10-29 15:30') }),
      OP_A,
      at('2026-10-29 10:03'),
    ),
    expected: reject('lpr_info_required', 'lprInfo'),
  },
  {
    id: 'r08i',
    refs: ['3.5 №8', '2.6'],
    title: '«ЛПР: нет» с заметкой вместо данных ЛПР принимается',
    input: inp(NEW_A, E08I, OP_A, E08I.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        callbackTouches: 1,
        nextCallAt: at('2026-10-29 15:30'),
        lpr: 'no',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 10:03'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-29 10:03'),
        lastConnectAt: at('2026-10-29 10:03'),
        lastTouchAt: at('2026-10-29 10:03'),
        version: 2,
      },
      fx({
        tasks: [callbackTask('op-r08i', A, at('2026-10-29 15:30'))],
        timeline: [tlCall('op-r08i', at('2026-10-29 10:03'), A, 'callback', 'new', 'callback')],
      }),
      rec(E08I, 'callback', A, A),
    ),
  },
  {
    id: 'r08j',
    refs: ['3.5 №8', '3.2'],
    title: 'Перезвон без даты и времени отклоняется',
    input: inp(NEW_A, oc({ opId: 'op-r08j', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes' }), OP_A, at('2026-10-29 10:03')),
    expected: reject('callback_at_required', 'callbackAt'),
  },

  // ===== № 9. Договорились =====
  {
    id: 'r09a',
    refs: ['3.5 №9', '2.10', 'D-036'],
    title: 'Договорились с записью: «Целевой: да», сделка на этапе on_agreed, задача-перезвон закрыта',
    input: inp(CB, E09A, OP_A, E09A.receivedAt),
    expected: ok(
      AG,
      fx({
        tasks: [closeCallbackTasks],
        deals: [{ op: 'ensure_open', stage: 'on_agreed', requestId: 'op-r09a' }],
        timeline: [tlCall('op-r09a', at('2026-10-29 15:34'), A, 'agreed', 'callback', 'agreed')],
      }),
      rec(E09A, 'agreed', A, A),
    ),
  },
  {
    id: 'r09b',
    refs: ['3.5 №9', 'D-049'],
    title: 'Договорённость с датой без записи → задача владельцу на эту дату',
    input: inp(NEW_A, E09B, OP_A, E09B.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'agreed',
        lpr: 'yes',
        isTarget: 'yes',
        lastOutcomeCode: 'agreed',
        lastOutcomeKind: 'agreed',
        lastOutcomeAt: at('2026-10-28 11:00'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-28 11:00'),
        lastConnectAt: at('2026-10-28 11:00'),
        lastTouchAt: at('2026-10-28 11:00'),
        version: 2,
      },
      fx({
        tasks: [
          { op: 'create', source: 'agreement', kind: 'call', assignee: { user: A }, dueAt: at('2026-11-02 11:00'), sourceKey: 'agreement:op-r09b' },
        ],
        deals: [{ op: 'ensure_open', stage: 'on_agreed', requestId: 'op-r09b' }],
        timeline: [tlCall('op-r09b', at('2026-10-28 11:00'), A, 'agreed', 'new', 'agreed')],
      }),
      rec(E09B, 'agreed', A, A),
    ),
  },
  {
    id: 'r09c',
    refs: ['3.5 №9', '3.2'],
    title: 'Договорились без контакта «кто придёт» отклоняется',
    input: inp(
      NEW_A,
      oc({
        opId: 'op-r09c',
        outcomeKey: 'agreed',
        occurredAt: at('2026-10-28 11:00'),
        lpr: 'yes',
        agreement: { contactId: null, bookingId: 'bk-1', agreedDueAt: null },
      }),
      OP_A,
      at('2026-10-28 11:00'),
    ),
    expected: reject('contact_required', 'agreement.contactId'),
  },
  {
    id: 'r09d',
    refs: ['3.5 №9', '3.2'],
    title: 'Договорились без записи и без даты договорённости отклоняется',
    input: inp(
      NEW_A,
      oc({
        opId: 'op-r09d',
        outcomeKey: 'agreed',
        occurredAt: at('2026-10-28 11:00'),
        lpr: 'yes',
        agreement: { contactId: 'contact-1', bookingId: null, agreedDueAt: null },
      }),
      OP_A,
      at('2026-10-28 11:00'),
    ),
    expected: reject('agreement_required', 'agreement'),
  },

  // ===== № 10. Не интересует =====
  {
    id: 'r10a',
    refs: ['3.5 №10', '2.10', '14 в.2'],
    title: 'Не интересует пт 23.10 11:00 → возврат через 90 дней (21.01.2027), «Целевой» не сбрасывается',
    input: inp({ ...NEW_A, isTarget: 'yes' }, E10A, OP_A, E10A.receivedAt),
    expected: ok(
      NI,
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'not_interested', reasonCode: 'too_expensive' }],
        timeline: [tlCall('op-r10a', at('2026-10-23 11:00'), A, 'not_interested', 'new', 'not_interested')],
      }),
      rec(E10A, 'not_interested', A, A),
    ),
  },
  {
    id: 'r10b',
    refs: ['3.5 №10', '3.2'],
    title: '«Не интересует» без причины отклоняется',
    input: inp(NEW_A, oc({ opId: 'op-r10b', outcomeKey: 'not_interested', occurredAt: at('2026-10-23 11:00'), lpr: 'yes' }), OP_A, at('2026-10-23 11:00')),
    expected: reject('reason_required', 'reasonCode'),
  },
  {
    id: 'r10c',
    refs: ['3.5 №10', 'CONFIG 6.6'],
    title: 'Настройка returnDays.not_interested = null: карточка закрыта без срока возврата',
    input: inp({ ...NEW_A, isTarget: 'yes' }, E10C, OP_A, E10C.receivedAt, withSettings({ returnDays: { not_interested: null, deal_lost_soft: 90 } })),
    expected: ok(
      { ...NI, returnAt: null },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'not_interested', reasonCode: 'too_expensive' }],
        timeline: [tlCall('op-r10c', at('2026-10-23 11:00'), A, 'not_interested', 'new', 'not_interested')],
      }),
      rec(E10C, 'not_interested', A, A),
    ),
  },

  // ===== № 11. Не целевой =====
  {
    id: 'r11a',
    refs: ['3.5 №11', 'D-036'],
    title: 'Не целевой итогом звонка: «Целевой: нет», задачи закрыты, сделки проиграны, будущие записи отменены',
    input: inp(NEW_A, E11A, OP_A, E11A.receivedAt),
    expected: ok(
      NT,
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'not_target', reasonCode: 'company_closed' }],
        bookings: [{ op: 'cancel_future', reason: 'not_target' }],
        timeline: [tlCall('op-r11a', at('2026-10-28 10:40'), A, 'not_target', 'new', 'not_target')],
      }),
      rec(E11A, 'not_target', A, A),
    ),
  },
  {
    id: 'r11b',
    refs: ['3.5 №11', '3.2'],
    title: 'Руководитель закрывает «Договорились» как «Не целевой» из меню: звонка нет, счётчики не меняются',
    input: inp(
      AG,
      { type: 'close_from_menu', opId: 'op-r11b', seenVersion: 5, kind: 'not_target', reasonCode: 'out_of_region', alsoDncPhoneIds: [] },
      LEAD,
      at('2026-10-30 12:00'),
    ),
    expected: ok(
      { ...AG, state: 'not_target', isTarget: 'no', closeReasonCode: 'out_of_region', closedAt: at('2026-10-30 12:00'), version: 6 },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'not_target', reasonCode: 'out_of_region' }],
        bookings: [{ op: 'cancel_future', reason: 'not_target' }],
        timeline: [tlState(at('2026-10-30 12:00'), 'u-lead', 'agreed', 'not_target', 'menu_close')],
      }),
    ),
  },

  // ===== № 12. Полный отказ =====
  {
    id: 'r12a',
    refs: ['3.5 №12', '2.9', '12.32'],
    title: 'Полный отказ: номер разговора и отмеченный — в стоп-лист, общий с другим клиентом — на подтверждение руководителю',
    input: inp({ ...CB, phones: [PH1, PH2, phone('ph-3', { sharedWithOtherClient: true })] }, E12A, OP_A, E12A.receivedAt),
    expected: ok(
      {
        ...CB,
        state: 'do_not_call',
        callbackTouches: 0,
        nextCallAt: null,
        lastOutcomeCode: 'do_not_call',
        lastOutcomeKind: 'do_not_call',
        lastOutcomeAt: at('2026-10-29 15:34'),
        closeReasonCode: 'asked_not_to_call',
        closedAt: at('2026-10-29 15:34'),
        callsTotal: 4,
        connectsTotal: 2,
        lastConnectAt: at('2026-10-29 15:34'),
        lastTouchAt: at('2026-10-29 15:34'),
        phones: [{ ...PH1, inStopList: true }, { ...PH2, inStopList: true }, phone('ph-3', { sharedWithOtherClient: true })],
        version: 5,
      },
      fx({
        tasks: [
          closeAllTasks,
          { op: 'create', source: 'review', kind: 'check', assignee: { role: 'lead' }, dueAt: null, sourceKey: 'dnc_confirm:op-r12a:ph-3' },
        ],
        deals: [{ op: 'lose_open', reasonGroup: 'do_not_call', reasonCode: 'asked_not_to_call' }],
        bookings: [{ op: 'cancel_future', reason: 'do_not_call' }],
        stopList: [
          { op: 'add', phoneId: 'ph-1', reasonCode: 'asked_not_to_call' },
          { op: 'add', phoneId: 'ph-2', reasonCode: 'asked_not_to_call' },
        ],
        timeline: [
          tlCall('op-r12a', at('2026-10-29 15:34'), A, 'do_not_call', 'callback', 'do_not_call'),
          { kind: 'dnc.set', at: at('2026-10-29 15:34'), actorId: A, ref: null, data: { phonesAdded: 2, phonesToReview: 1 } },
        ],
      }),
      rec(E12A, 'do_not_call', A, A),
    ),
  },
  {
    id: 'r12b',
    refs: ['3.5 №12', '3.3', '5.3'],
    title: 'Клиент просит не звонить, руководитель ставит из меню: без отмеченных номеров в стоп-лист уходит основной',
    input: inp(
      CL,
      { type: 'close_from_menu', opId: 'op-r12b', seenVersion: 6, kind: 'do_not_call', reasonCode: 'asked_not_to_call', alsoDncPhoneIds: [] },
      LEAD,
      at('2026-11-20 10:00'),
    ),
    expected: ok(
      {
        ...CL,
        state: 'do_not_call',
        closeReasonCode: 'asked_not_to_call',
        closedAt: at('2026-11-20 10:00'),
        phones: [{ ...PH1, inStopList: true }],
        version: 7,
      },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'do_not_call', reasonCode: 'asked_not_to_call' }],
        bookings: [{ op: 'cancel_future', reason: 'do_not_call' }],
        stopList: [{ op: 'add', phoneId: 'ph-1', reasonCode: 'asked_not_to_call' }],
        timeline: [
          tlState(at('2026-11-20 10:00'), 'u-lead', 'client', 'do_not_call', 'menu_close'),
          { kind: 'dnc.set', at: at('2026-11-20 10:00'), actorId: 'u-lead', ref: null, data: { phonesAdded: 1, phonesToReview: 0 } },
        ],
      }),
    ),
  },

  // ===== № 13. Возврат по сроку =====
  {
    id: 'r13a',
    refs: ['3.5 №13', '2.10', '7.3'],
    title: 'Возврат «Не интересует» через 90 дней: «Перезвон: сейчас», новый цикл попыток, лимит +1, сводное уведомление',
    input: inp(
      NI,
      { type: 'return_due', opId: 'op-r13a', runId: 'run-0121-1200', facts: { ownerActive: true, capRemaining: 10 } },
      SYS,
      at('2027-01-21 12:00'),
    ),
    expected: ok(
      {
        ...NI,
        state: 'callback',
        nextCallAt: at('2027-01-21 12:00'),
        returnAt: null,
        closeReasonCode: '',
        closedAt: null,
        assignedAt: at('2027-01-21 12:00'),
        version: 3,
      },
      fx({
        tasks: [callbackTask('op-r13a', A, at('2027-01-21 12:00'))],
        assignLog: [{ kind: 'return', fromUserId: null, toUserId: A, countsToCap: true }],
        notifications: [{ kind: 'card_returned', to: { user: A }, dedupeKey: 'return:run-0121-1200:u-op-a' }],
        timeline: [tlState(at('2027-01-21 12:00'), null, 'not_interested', 'callback', 'return_due')],
      }),
    ),
  },
  {
    id: 'r13b',
    refs: ['3.5 №13', '12.23'],
    title: 'Срок возврата наступил, но лимит владельца исчерпан — ждёт следующего дня',
    input: inp(
      NI,
      { type: 'return_due', opId: 'op-r13b', runId: 'run-0121-1200', facts: { ownerActive: true, capRemaining: 0 } },
      SYS,
      at('2027-01-21 12:00'),
    ),
    expected: reject('cap_exhausted'),
  },
  {
    id: 'r13c',
    refs: ['3.5 №13', '12.24'],
    title: 'Владелец к сроку возврата уволен → «Новая» в пул',
    input: inp(
      NI,
      { type: 'return_due', opId: 'op-r13c', runId: 'run-0121-1200', facts: { ownerActive: false, capRemaining: 0 } },
      SYS,
      at('2027-01-21 12:00'),
    ),
    expected: ok(
      { ...NI, state: 'new', ownerUserId: null, assignedAt: null, returnAt: null, closeReasonCode: '', closedAt: null, version: 3 },
      fx({
        assignLog: [{ kind: 'release', fromUserId: A, toUserId: null, countsToCap: false }],
        timeline: [tlState(at('2027-01-21 12:00'), null, 'not_interested', 'new', 'return_due')],
      }),
    ),
  },
  {
    id: 'r13d',
    refs: ['3.5 №13'],
    title: 'Срок возврата не наступил — недопустимый переход',
    input: inp(
      NI,
      { type: 'return_due', opId: 'op-r13d', runId: 'run-0120-1200', facts: { ownerActive: true, capRemaining: 10 } },
      SYS,
      at('2027-01-20 12:00'),
    ),
    expected: reject('invalid_transition'),
  },

  // ===== № 14. Вернуть в обзвон =====
  {
    id: 'r14a',
    refs: ['3.5 №14', '2.9'],
    title: 'Руководитель возвращает списанную: «Перезвон: сейчас», попытки с нуля, уведомление владельцу',
    input: inp(WO, { type: 'reopen', opId: 'op-r14a', seenVersion: 4, comment: 'найден новый номер' }, LEAD, at('2026-10-30 09:30')),
    expected: ok(
      { ...WO, state: 'callback', attempts: 0, nextCallAt: at('2026-10-30 09:30'), closeReasonCode: '', closedAt: null, version: 5 },
      fx({
        tasks: [callbackTask('op-r14a', A, at('2026-10-30 09:30'))],
        notifications: [{ kind: 'card_reopened', to: { user: A }, dedupeKey: null }],
        timeline: [tlState(at('2026-10-30 09:30'), 'u-lead', 'written_off', 'callback', 'reopen')],
      }),
    ),
  },
  {
    id: 'r14b',
    refs: ['3.5 №14', 'D-036'],
    title: 'Возврат «Не целевого»: «Целевой» сбрасывается в «не выяснено»',
    input: inp(NT, { type: 'reopen', opId: 'op-r14b', seenVersion: 2, comment: 'компания снова работает' }, LEAD, at('2026-10-30 09:30')),
    expected: ok(
      { ...NT, state: 'callback', isTarget: '', nextCallAt: at('2026-10-30 09:30'), closeReasonCode: '', closedAt: null, version: 3 },
      fx({
        tasks: [callbackTask('op-r14b', A, at('2026-10-30 09:30'))],
        notifications: [{ kind: 'card_reopened', to: { user: A }, dedupeKey: null }],
        timeline: [tlState(at('2026-10-30 09:30'), 'u-lead', 'not_target', 'callback', 'reopen')],
      }),
    ),
  },
  {
    id: 'r14c',
    refs: ['3.5 №14'],
    title: 'Возврат без комментария (только пробелы) отклоняется',
    input: inp(WO, { type: 'reopen', opId: 'op-r14c', seenVersion: 4, comment: '   ' }, LEAD, at('2026-10-30 09:30')),
    expected: reject('comment_required', 'comment'),
  },

  // ===== № 15. Снять «Не звонить» =====
  {
    id: 'r15a',
    refs: ['3.5 №15', '8.6'],
    title: 'Снять «Не звонить»: номер удалён из стоп-листа, кроме номера, который держит другой клиент; аудит',
    input: inp(
      DNC,
      { type: 'dnc_clear', opId: 'op-r15a', seenVersion: 2, comment: 'клиент сам попросил связаться' },
      LEAD,
      at('2026-10-30 10:00'),
    ),
    expected: ok(
      {
        ...DNC,
        state: 'callback',
        nextCallAt: at('2026-10-30 10:00'),
        closeReasonCode: '',
        closedAt: null,
        phones: [PH1, phone('ph-2', { kind: 'landline', inStopList: true, heldByOtherDncClient: true })],
        version: 3,
      },
      fx({
        tasks: [callbackTask('op-r15a', A, at('2026-10-30 10:00'))],
        stopList: [{ op: 'remove', phoneId: 'ph-1' }],
        audit: [{ kind: 'dnc.cleared', data: { cardId: 'card-1', phonesRemoved: 1 } }],
        timeline: [
          tlState(at('2026-10-30 10:00'), 'u-lead', 'do_not_call', 'callback', 'dnc_clear'),
          { kind: 'dnc.cleared', at: at('2026-10-30 10:00'), actorId: 'u-lead', ref: null, data: { phonesRemoved: 1 } },
        ],
      }),
    ),
  },

  // ===== № 16. Не пришёл =====
  {
    id: 'r16a',
    refs: ['3.5 №16', '2.7', 'CONFIG 6.9'],
    title: 'Не пришёл чт 05.11: «Перезвон» на следующий рабочий день 10:00, задача «перезаписать», значок сделки',
    input: inp(AG, { type: 'no_show', opId: 'op-r16a', bookingId: 'bk-1', facts: { hasOtherFutureBooking: false } }, DUTY, at('2026-11-05 15:20')),
    expected: ok(
      NS,
      fx({
        tasks: [{ op: 'create', source: 'no_show', kind: 'call', assignee: { user: A }, dueAt: at('2026-11-06 10:00'), sourceKey: 'no_show:bk-1' }],
        deals: [{ op: 'set_needs_rebook', bookingId: 'bk-1', value: true }],
        notifications: [{ kind: 'no_show', to: { user: A }, dedupeKey: null }],
        timeline: [tlState(at('2026-11-05 15:20'), 'u-duty', 'agreed', 'callback', 'no_show')],
      }),
    ),
  },
  {
    id: 'r16b',
    refs: ['3.5 №16'],
    title: 'Не пришёл, но есть другая активная будущая запись — карточка остаётся «Договорились»',
    input: inp(AG, { type: 'no_show', opId: 'op-r16b', bookingId: 'bk-1', facts: { hasOtherFutureBooking: true } }, DUTY, at('2026-11-05 15:20')),
    expected: ok(AG),
  },

  // ===== № 17. Запись отменена =====
  {
    id: 'r17a',
    refs: ['3.5 №17'],
    title: 'Клиент отменил запись: «Перезвон: сейчас», задача «перезаписать», значок сделки',
    input: inp(
      AG,
      { type: 'booking_cancelled', opId: 'op-r17a', bookingId: 'bk-1', reason: 'client', createdByOpId: null, facts: { hasOtherFutureBooking: false } },
      OP_A,
      at('2026-10-30 11:00'),
    ),
    expected: ok(
      { ...AG, state: 'callback', nextCallAt: at('2026-10-30 11:00'), version: 6 },
      fx({
        tasks: [{ op: 'create', source: 'rebook', kind: 'call', assignee: { user: A }, dueAt: at('2026-10-30 11:00'), sourceKey: 'rebook:bk-1' }],
        deals: [{ op: 'set_needs_rebook', bookingId: 'bk-1', value: true }],
        timeline: [tlState(at('2026-10-30 11:00'), A, 'agreed', 'callback', 'booking_cancelled')],
      }),
    ),
  },
  {
    id: 'r17b',
    refs: ['3.5 №17', '12.7'],
    title: 'Ошибочное «Договорились»: отмена записи «ошибка оператора» закрывает созданную сделку, «Перезвон: сейчас»',
    input: inp(
      AG,
      {
        type: 'booking_cancelled',
        opId: 'op-r17b',
        bookingId: 'bk-1',
        reason: 'operator_error',
        createdByOpId: 'op-r09a',
        facts: { hasOtherFutureBooking: false },
      },
      OP_A,
      at('2026-10-29 15:40'),
    ),
    expected: ok(
      { ...AG, state: 'callback', nextCallAt: at('2026-10-29 15:40'), version: 6 },
      fx({
        tasks: [callbackTask('op-r17b', A, at('2026-10-29 15:40'))],
        deals: [{ op: 'lose_created_by', opId: 'op-r09a', reasonCode: 'input_error' }],
        timeline: [tlState(at('2026-10-29 15:40'), A, 'agreed', 'callback', 'booking_cancelled')],
      }),
    ),
  },

  // ===== № 18. Пришёл =====
  {
    id: 'r18a',
    refs: ['3.5 №18', 'D-049'],
    title: 'Пришёл, следующей записи нет: сделка → on_attended, задача «Записать на следующий шаг» пт 10:00',
    input: inp(
      AG,
      { type: 'attended', opId: 'op-r18a', bookingId: 'bk-1', eventDay: '2026-11-05', facts: { hasNextFutureBooking: false } },
      DUTY,
      at('2026-11-05 15:05'),
    ),
    expected: ok(
      AG,
      fx({
        tasks: [{ op: 'create', source: 'next_step', kind: 'call', assignee: { user: A }, dueAt: at('2026-11-06 10:00'), sourceKey: 'next_step:bk-1' }],
        deals: [{ op: 'advance', stage: 'on_attended', bookingId: 'bk-1' }],
      }),
    ),
  },
  {
    id: 'r18b',
    refs: ['3.5 №18', '5.3'],
    title: '«Пришёл» до начала суток мероприятия отклоняется',
    input: inp(
      AG,
      { type: 'attended', opId: 'op-r18b', bookingId: 'bk-1', eventDay: '2026-11-05', facts: { hasNextFutureBooking: false } },
      DUTY,
      at('2026-11-04 18:00'),
    ),
    expected: reject('too_early'),
  },

  // ===== № 19. Покупка =====
  {
    id: 'r19a',
    refs: ['3.5 №19', '2.8'],
    title: 'Покупка из «Договорились» → «Клиент», сделка выиграна',
    input: inp(
      AG,
      { type: 'purchase', opId: 'op-r19a', dealId: 'deal-1', serviceTypeKey: 'service_a', amountKzt: 450000 },
      CONS,
      at('2026-11-12 14:00'),
    ),
    expected: ok(
      CL,
      fx({
        deals: [{ op: 'win', dealId: 'deal-1', serviceTypeKey: 'service_a', amountKzt: 450000, requestId: 'op-r19a' }],
        timeline: [tlState(at('2026-11-12 14:00'), 'u-cons', 'agreed', 'client', 'purchase')],
      }),
    ),
  },
  {
    id: 'r19b',
    refs: ['3.5 №19', 'D-050'],
    title: 'Покупка из «Перезвона»: задача-перезвон закрыта, срок снят',
    input: inp(
      CB,
      { type: 'purchase', opId: 'op-r19b', dealId: null, serviceTypeKey: 'service_a', amountKzt: 100000 },
      LEAD,
      at('2026-10-29 12:00'),
    ),
    expected: ok(
      { ...CB, state: 'client', nextCallAt: null, callbackTouches: 0, version: 5 },
      fx({
        tasks: [closeCallbackTasks],
        deals: [{ op: 'win', dealId: null, serviceTypeKey: 'service_a', amountKzt: 100000, requestId: 'op-r19b' }],
        timeline: [tlState(at('2026-10-29 12:00'), 'u-lead', 'callback', 'client', 'purchase')],
      }),
    ),
  },
  {
    id: 'r19c',
    refs: ['3.5 №19', '3.3'],
    title: 'Повторная покупка клиента: состояние то же, карточка не меняется',
    input: inp(CL, { type: 'purchase', opId: 'op-r19c', dealId: 'deal-2', serviceTypeKey: 'service_b', amountKzt: 200000 }, LEAD, at('2026-12-01 12:00')),
    expected: ok(CL, fx({ deals: [{ op: 'win', dealId: 'deal-2', serviceTypeKey: 'service_b', amountKzt: 200000, requestId: 'op-r19c' }] })),
  },
  {
    id: 'r19d',
    refs: ['3.5 №19'],
    title: 'Покупка из «Новой» — недопустимый переход',
    input: inp(NEW_A, { type: 'purchase', opId: 'op-r19d', dealId: null, serviceTypeKey: 'service_a', amountKzt: 1000 }, LEAD, at('2026-10-29 12:00')),
    expected: reject('invalid_transition'),
  },
  {
    id: 'r19e',
    refs: ['3.5 №19', '4.2'],
    title: 'Покупка с отрицательной суммой отклоняется',
    input: inp(AG, { type: 'purchase', opId: 'op-r19e', dealId: 'deal-1', serviceTypeKey: 'service_a', amountKzt: -1 }, LEAD, at('2026-11-12 14:00')),
    expected: reject('amount_invalid', 'amountKzt'),
  },

  // ===== № 20. Покупка отменена =====
  {
    id: 'r20a',
    refs: ['3.5 №20', '12.29'],
    title: 'Покупка отменена, есть другая открытая сделка → «Договорились»',
    input: inp(
      CL,
      { type: 'purchase_cancelled', opId: 'op-r20a', dealId: 'deal-1', comment: 'возврат денег', facts: { hasOtherOpenDeal: true } },
      LEAD,
      at('2026-11-13 10:00'),
    ),
    expected: ok(
      { ...CL, state: 'agreed', version: 7 },
      fx({
        deals: [{ op: 'cancel_purchase', dealId: 'deal-1' }],
        timeline: [tlState(at('2026-11-13 10:00'), 'u-lead', 'client', 'agreed', 'purchase_cancelled')],
      }),
    ),
  },
  {
    id: 'r20b',
    refs: ['3.5 №20', '12.29'],
    title: 'Покупка отменена, открытых сделок нет → «Перезвон: сейчас»',
    input: inp(
      CL,
      { type: 'purchase_cancelled', opId: 'op-r20b', dealId: 'deal-1', comment: 'ошибка регистрации', facts: { hasOtherOpenDeal: false } },
      LEAD,
      at('2026-11-13 10:00'),
    ),
    expected: ok(
      { ...CL, state: 'callback', nextCallAt: at('2026-11-13 10:00'), version: 7 },
      fx({
        tasks: [callbackTask('op-r20b', A, at('2026-11-13 10:00'))],
        deals: [{ op: 'cancel_purchase', dealId: 'deal-1' }],
        timeline: [tlState(at('2026-11-13 10:00'), 'u-lead', 'client', 'callback', 'purchase_cancelled')],
      }),
    ),
  },

  // ===== № 21. Сделка проиграна =====
  {
    id: 'r21a',
    refs: ['3.5 №21', '14 в.11'],
    title: 'Сделка проиграна по мягкой причине → «Не интересует», возврат через deal_lost_soft дней',
    input: inp(
      AG,
      { type: 'deal_lost', opId: 'op-r21a', dealId: 'deal-1', reasonCode: 'no_time', softness: 'soft', facts: { hasOtherOpenDeal: false } },
      CONS,
      at('2026-11-10 12:00'),
    ),
    expected: ok(
      {
        ...AG,
        state: 'not_interested',
        returnAt: at('2027-02-08 12:00'),
        closeReasonCode: 'no_time',
        closedAt: at('2026-11-10 12:00'),
        version: 6,
      },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose', dealId: 'deal-1', reasonGroup: 'deal_lost', reasonCode: 'no_time' }],
        timeline: [tlState(at('2026-11-10 12:00'), 'u-cons', 'agreed', 'not_interested', 'deal_lost')],
      }),
    ),
  },
  {
    id: 'r21b',
    refs: ['3.5 №21'],
    title: 'Сделка проиграна по жёсткой причине → «Не целевой», будущие записи отменены',
    input: inp(
      AG,
      { type: 'deal_lost', opId: 'op-r21b', dealId: 'deal-1', reasonCode: 'company_closed', softness: 'hard', facts: { hasOtherOpenDeal: false } },
      LEAD,
      at('2026-11-10 12:00'),
    ),
    expected: ok(
      { ...AG, state: 'not_target', isTarget: 'no', closeReasonCode: 'company_closed', closedAt: at('2026-11-10 12:00'), version: 6 },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose', dealId: 'deal-1', reasonGroup: 'deal_lost', reasonCode: 'company_closed' }],
        bookings: [{ op: 'cancel_future', reason: 'not_target' }],
        timeline: [tlState(at('2026-11-10 12:00'), 'u-lead', 'agreed', 'not_target', 'deal_lost')],
      }),
    ),
  },
  {
    id: 'r21c',
    refs: ['3.5 №21'],
    title: 'Проиграна одна из двух открытых сделок — карточка остаётся «Договорились»',
    input: inp(
      AG,
      { type: 'deal_lost', opId: 'op-r21c', dealId: 'deal-1', reasonCode: 'no_time', softness: 'soft', facts: { hasOtherOpenDeal: true } },
      LEAD,
      at('2026-11-10 12:00'),
    ),
    expected: ok(AG, fx({ deals: [{ op: 'lose', dealId: 'deal-1', reasonGroup: 'deal_lost', reasonCode: 'no_time' }] })),
  },

  // ===== № 22. Передача клиента =====
  {
    id: 'r22a',
    refs: ['3.5 №22', '8.5'],
    title: 'Передача от оператора А оператору Б: задачи, открытые сделки и будущие записи переходят, лимит не тратится',
    input: inp(CB, { type: 'transfer', opId: 'op-r22a', seenVersion: 4, toUserId: B, facts: { toUserActive: true } }, LEAD, at('2026-10-30 09:00')),
    expected: ok(
      { ...CB, ownerUserId: B, version: 5 },
      fx({
        tasks: [{ op: 'reassign_open', to: B }],
        deals: [{ op: 'reassign_open', to: B }],
        bookings: [{ op: 'reassign_future', to: B }],
        assignLog: [{ kind: 'transfer', fromUserId: A, toUserId: B, countsToCap: false }],
        notifications: [{ kind: 'client_transferred', to: { user: B }, dedupeKey: null }],
        timeline: [{ kind: 'card.transferred', at: at('2026-10-30 09:00'), actorId: 'u-lead', ref: null, data: { fromUserId: A, toUserId: B } }],
      }),
    ),
  },
  {
    id: 'r22b',
    refs: ['3.5 №22'],
    title: 'Передача неактивному сотруднику отклоняется',
    input: inp(CB, { type: 'transfer', opId: 'op-r22b', seenVersion: 4, toUserId: B, facts: { toUserActive: false } }, LEAD, at('2026-10-30 09:00')),
    expected: reject('user_inactive', 'toUserId'),
  },

  // ===== № 23. Отсутствует =====
  {
    id: 'r23a',
    refs: ['3.5 №23', '7.5', 'D-041'],
    title: 'Отсутствие 28–30.10: перезвон получает временного владельца, владелец не меняется',
    input: inp(CB, { type: 'absence', opId: 'op-r23a', actingUserId: B, untilDay: '2026-10-30' }, LEAD, at('2026-10-27 18:30')),
    expected: ok(
      { ...CB, actingUserId: B, actingUntilDay: '2026-10-30', version: 5 },
      fx({
        assignLog: [{ kind: 'absence', fromUserId: A, toUserId: B, countsToCap: false }],
        timeline: [{ kind: 'card.acting', at: at('2026-10-27 18:30'), actorId: 'u-lead', ref: null, data: { actingUserId: B, untilDay: '2026-10-30' } }],
      }),
    ),
  },
  {
    id: 'r23b',
    refs: ['3.5 №23', '3.5 №3', '7.5'],
    title: 'Отсутствие: нетронутая новая возвращается в пул',
    input: inp(NEW_A, { type: 'absence', opId: 'op-r23b', actingUserId: B, untilDay: '2026-10-30' }, LEAD, at('2026-10-27 18:30')),
    expected: ok(
      { ...NEW_A, ownerUserId: null, assignedAt: null, version: 2 },
      fx({
        assignLog: [{ kind: 'release', fromUserId: A, toUserId: null, countsToCap: false }],
        timeline: [{ kind: 'card.released', at: at('2026-10-27 18:30'), actorId: 'u-lead', ref: null, data: { fromUserId: A } }],
      }),
    ),
  },

  // ===== № 24. Слияние клиентов =====
  {
    id: 'r24a',
    refs: ['3.5 №24', '12.20'],
    title: 'Слияние с карточкой «Не звонить»: «Не звонить» побеждает всегда, счётчики суммируются',
    input: inp(
      R1,
      {
        type: 'merge',
        opId: 'op-r24a',
        seenVersion: 2,
        ownerFrom: 'auto',
        other: {
          ...DNC,
          id: 'card-2',
          clientId: 'client-2',
          phones: [phone('ph-5', { isPrimary: true, inStopList: true })],
          version: 3,
        },
      },
      LEAD,
      at('2026-10-30 12:00'),
    ),
    expected: ok(
      {
        ...R1,
        state: 'do_not_call',
        attempts: 0,
        nextCallAt: null,
        lastOutcomeCode: 'do_not_call',
        lastOutcomeKind: 'do_not_call',
        lastOutcomeAt: at('2026-10-22 12:00'),
        closeReasonCode: 'asked_not_to_call',
        closedAt: at('2026-10-22 12:00'),
        callsTotal: 2,
        connectsTotal: 1,
        noAnswerTotal: 1,
        firstConnectAt: at('2026-10-22 12:00'),
        lastConnectAt: at('2026-10-22 12:00'),
        lastTouchAt: at('2026-10-28 10:14'),
        phones: [PH1, phone('ph-5', { inStopList: true })],
        version: 3,
      },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'do_not_call', reasonCode: 'asked_not_to_call' }],
        bookings: [{ op: 'cancel_future', reason: 'do_not_call' }],
        audit: [{ kind: 'card.merged', data: { cardId: 'card-1', otherCardId: 'card-2' } }],
        timeline: [{ kind: 'card.merged', at: at('2026-10-30 12:00'), actorId: 'u-lead', ref: null, data: { otherCardId: 'card-2', stateFrom: 'other' } }],
      }),
    ),
  },
  {
    id: 'r24b',
    refs: ['3.5 №24', '12.20', '12.21'],
    title: 'Слияние разных владельцев: состояние и владелец — у карточки с более поздним итогом; проигравший теряет доступ',
    input: inp(
      R1,
      {
        type: 'merge',
        opId: 'op-r24b',
        seenVersion: 2,
        ownerFrom: 'auto',
        other: {
          ...CB,
          id: 'card-2',
          clientId: 'client-2',
          ownerUserId: B,
          assignedAt: at('2026-10-20 08:00'),
          phones: [phone('ph-6', { isPrimary: true })],
        },
      },
      LEAD,
      at('2026-10-30 12:00'),
    ),
    expected: ok(
      {
        ...R1,
        ownerUserId: B,
        assignedAt: at('2026-10-20 08:00'),
        state: 'callback',
        attempts: 0,
        nextCallAt: at('2026-10-29 15:30'),
        callbackTouches: 1,
        lpr: 'no',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 10:03'),
        callsTotal: 4,
        connectsTotal: 1,
        noAnswerTotal: 3,
        firstConnectAt: at('2026-10-29 10:03'),
        lastConnectAt: at('2026-10-29 10:03'),
        lastTouchAt: at('2026-10-29 10:03'),
        phones: [PH1, phone('ph-6')],
        version: 3,
      },
      fx({
        tasks: [{ op: 'reassign_open', to: B }],
        deals: [{ op: 'reassign_open', to: B }],
        bookings: [{ op: 'reassign_future', to: B }],
        assignLog: [{ kind: 'merge', fromUserId: A, toUserId: B, countsToCap: false }],
        notifications: [{ kind: 'card_merged', to: { user: A }, dedupeKey: null }],
        audit: [{ kind: 'card.merged', data: { cardId: 'card-1', otherCardId: 'card-2' } }],
        timeline: [{ kind: 'card.merged', at: at('2026-10-30 12:00'), actorId: 'u-lead', ref: null, data: { otherCardId: 'card-2', stateFrom: 'other' } }],
      }),
    ),
  },

  {
    id: 'v2_merge_survivor_day',
    refs: ['pipeline-v2 §3.3 № 24', 'pipeline-v2 §4.3'],
    title: 'Слияние: донор состояния — остающаяся карточка, срок «день», причина и касания перезвона сохраняются',
    input: inp(
      { ...CB, nextCallAt: at('2026-10-30 09:00'), nextCallPrecision: 'day', callbackReason: 'think', callbackTouches: 2 },
      {
        type: 'merge',
        opId: 'op-v2m1',
        seenVersion: 4,
        ownerFrom: 'auto',
        other: { ...NEW_A, id: 'card-2', clientId: 'client-2', phones: [phone('ph-7', { isPrimary: true })] },
      },
      LEAD,
      at('2026-10-30 12:00'),
    ),
    expected: ok(
      {
        ...CB,
        nextCallAt: at('2026-10-30 09:00'),
        nextCallPrecision: 'day',
        callbackReason: 'think',
        callbackTouches: 2,
        phones: [PH1, phone('ph-7')],
        version: 5,
      },
      fx({
        audit: [{ kind: 'card.merged', data: { cardId: 'card-1', otherCardId: 'card-2' } }],
        timeline: [{ kind: 'card.merged', at: at('2026-10-30 12:00'), actorId: 'u-lead', ref: null, data: { otherCardId: 'card-2', stateFrom: 'survivor' } }],
      }),
    ),
  },
  {
    id: 'v2_merge_other_day',
    refs: ['pipeline-v2 §3.3 № 24', 'pipeline-v2 §4.3'],
    title: 'Слияние: донор состояния — уходящая карточка, срок «день», причина и касания перезвона переходят к остающейся',
    input: inp(
      R1,
      {
        type: 'merge',
        opId: 'op-v2m2',
        seenVersion: 2,
        ownerFrom: 'auto',
        other: {
          ...CB,
          id: 'card-2',
          clientId: 'client-2',
          nextCallAt: at('2026-10-30 09:00'),
          nextCallPrecision: 'day',
          callbackReason: 'think',
          callbackTouches: 2,
          phones: [phone('ph-6', { isPrimary: true })],
        },
      },
      LEAD,
      at('2026-10-30 12:00'),
    ),
    expected: ok(
      {
        ...R1,
        state: 'callback',
        attempts: 0,
        nextCallAt: at('2026-10-30 09:00'),
        nextCallPrecision: 'day',
        callbackReason: 'think',
        callbackTouches: 2,
        lpr: 'no',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 10:03'),
        callsTotal: 4,
        connectsTotal: 1,
        noAnswerTotal: 3,
        firstConnectAt: at('2026-10-29 10:03'),
        lastConnectAt: at('2026-10-29 10:03'),
        lastTouchAt: at('2026-10-29 10:03'),
        phones: [PH1, phone('ph-6')],
        version: 3,
      },
      fx({
        audit: [{ kind: 'card.merged', data: { cardId: 'card-1', otherCardId: 'card-2' } }],
        timeline: [{ kind: 'card.merged', at: at('2026-10-30 12:00'), actorId: 'u-lead', ref: null, data: { otherCardId: 'card-2', stateFrom: 'other' } }],
      }),
    ),
  },

  // ===== № 25. Пропустить =====
  {
    id: 'r25a',
    refs: ['3.5 №25', '7.4'],
    title: 'Пропуск: карточка не меняется, пропуск записан за местные сутки',
    input: inp(R1, { type: 'skip', opId: 'op-r25a', facts: { skipsToday: 3 } }, OP_A, at('2026-10-28 12:20')),
    expected: ok(R1, fx({ skips: [{ opId: 'op-r25a', day: '2026-10-28' }] })),
  },
  {
    id: 'r25b',
    refs: ['3.5 №25', '12.25'],
    title: 'Одиннадцатый пропуск за день отклоняется',
    input: inp(R1, { type: 'skip', opId: 'op-r25b', facts: { skipsToday: 10 } }, OP_A, at('2026-10-28 16:00')),
    expected: reject('skip_limit'),
  },

  // ===== № 26. Отменить итог =====
  {
    id: 'r26a',
    refs: ['3.5 №26', '12.6', 'D-019'],
    title: 'Недозвон отменён за 5 с на устройстве и не дошёл; сервер видит только следующий итог — недозвонов не прибавилось',
    input: inp(R1, E26A, OP_A, E26A.receivedAt),
    expected: ok(
      {
        ...R1,
        state: 'callback',
        callbackTouches: 1,
        attempts: 0,
        nextCallAt: at('2026-10-29 11:00'),
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-28 12:22'),
        callsTotal: 2,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-28 12:22'),
        lastConnectAt: at('2026-10-28 12:22'),
        lastTouchAt: at('2026-10-28 12:22'),
        version: 3,
      },
      fx({
        tasks: [callbackTask('op-r26a', A, at('2026-10-29 11:00'))],
        timeline: [tlCall('op-r26a', at('2026-10-28 12:22'), A, 'callback', 'retry', 'callback')],
      }),
      rec(E26A, 'callback', A, A),
    ),
  },

  // ===== № 27. Входящее от клиента =====
  {
    id: 'r27a',
    refs: ['3.5 №27'],
    title: '«Вернуть в работу» по входящему: «Не интересует» → «Перезвон: сейчас», попытки с нуля',
    input: inp(NI, { type: 'inbound_reactivate', opId: 'op-r27a', seenVersion: 2 }, OP_A, at('2026-11-10 11:00')),
    expected: ok(
      { ...NI, state: 'callback', nextCallAt: at('2026-11-10 11:00'), returnAt: null, closeReasonCode: '', closedAt: null, version: 3 },
      fx({
        tasks: [callbackTask('op-r27a', A, at('2026-11-10 11:00'))],
        timeline: [tlState(at('2026-11-10 11:00'), A, 'not_interested', 'callback', 'inbound_reactivate')],
      }),
    ),
  },
  {
    id: 'r27b',
    refs: ['3.5 №27', '12.22', 'D-024'],
    title: 'Входящее сообщение по «Не звонить»: состояние не меняется, задача руководителю',
    input: inp(DNC, { type: 'inbound_message', opId: 'op-r27b', channel: 'messenger' }, SYS, at('2026-10-30 10:00')),
    expected: ok(
      DNC,
      fx({ tasks: [{ op: 'create', source: 'dnc_inbound', kind: 'check', assignee: { role: 'lead' }, dueAt: null, sourceKey: 'dnc_inbound:op-r27b' }] }),
    ),
  },
  {
    id: 'r27c',
    refs: ['3.5 №27', '2.2', 'CONFIG 6.12'],
    title: 'Входящее сообщение по «Не интересует»: состояние не меняется, задача владельцу «Ответить» через 15 минут',
    input: inp(NI, { type: 'inbound_message', opId: 'op-r27c', channel: 'messenger' }, SYS, at('2026-11-10 10:45')),
    expected: ok(
      NI,
      fx({
        tasks: [
          { op: 'create', source: 'inbound_message', kind: 'message', assignee: { user: A }, dueAt: at('2026-11-10 11:00'), sourceKey: 'inbound:op-r27c' },
        ],
      }),
    ),
  },
  {
    id: 'r27d',
    refs: ['3.5 №27', '12.22'],
    title: '«Вернуть в работу» по «Не звонить» нельзя: снимает только руководитель (№ 15)',
    input: inp(DNC, { type: 'inbound_reactivate', opId: 'op-r27d', seenVersion: 2 }, OP_A, at('2026-10-30 10:00')),
    expected: reject('invalid_transition'),
  },

  // ===== № 28. Явка не отмечена =====
  {
    id: 'r28a',
    refs: ['3.5 №28', '2.7', 'D-049'],
    title: 'Мероприятие чт 22.10 без отметки, пт 23.10 10:00: задачи «Отметьте явку» дежурному и руководителю, карточка не меняется',
    input: inp(
      AG,
      {
        type: 'attendance_sweep',
        opId: 'op-r28a',
        bookingId: 'bk-3',
        markerUserId: 'u-duty',
        facts: { workdaysElapsed: 1, hasOtherFutureBooking: false },
      },
      SYS,
      at('2026-10-23 10:00'),
    ),
    expected: ok(
      AG,
      fx({
        tasks: [
          {
            op: 'create',
            source: 'attendance_mark',
            kind: 'check',
            assignee: { user: 'u-duty' },
            dueAt: at('2026-10-23 10:00'),
            sourceKey: 'attendance_mark:bk-3:marker',
          },
          {
            op: 'create',
            source: 'attendance_mark',
            kind: 'check',
            assignee: { role: 'lead' },
            dueAt: at('2026-10-23 10:00'),
            sourceKey: 'attendance_mark:bk-3:lead',
          },
        ],
      }),
    ),
  },
  {
    id: 'r28b',
    refs: ['3.5 №28', '3.5 №16', 'D-049'],
    title: 'Через 2 рабочих дня (вт 27.10, пн 26.10 выходной) — автонеявка: «Перезвон» ср 28.10 10:00, как № 16',
    input: inp(
      AG,
      {
        type: 'attendance_sweep',
        opId: 'op-r28b',
        bookingId: 'bk-3',
        markerUserId: 'u-duty',
        facts: { workdaysElapsed: 2, hasOtherFutureBooking: false },
      },
      SYS,
      at('2026-10-27 10:00'),
    ),
    expected: ok(
      { ...AG, state: 'callback', nextCallAt: at('2026-10-28 10:00'), version: 6 },
      fx({
        tasks: [
          { op: 'close_by_key', sourceKey: 'attendance_mark:bk-3:marker' },
          { op: 'close_by_key', sourceKey: 'attendance_mark:bk-3:lead' },
          { op: 'create', source: 'no_show', kind: 'call', assignee: { user: A }, dueAt: at('2026-10-28 10:00'), sourceKey: 'no_show:bk-3' },
        ],
        deals: [{ op: 'set_needs_rebook', bookingId: 'bk-3', value: true }],
        notifications: [{ kind: 'no_show', to: { user: A }, dedupeKey: null }],
        timeline: [tlState(at('2026-10-27 10:00'), null, 'agreed', 'callback', 'no_show')],
      }),
    ),
  },

  // ===== № 29. Договорились без следующего шага =====
  {
    id: 'r29a',
    refs: ['3.5 №29', 'D-049'],
    title: 'Ночная сверка: «Договорились» без записи и задачи → задача «Записать на следующий шаг» на следующий рабочий день 10:00',
    input: inp(AG, { type: 'agreed_sweep', opId: 'op-r29a', facts: { hasFutureBooking: false, hasOpenOwnerTask: false } }, SYS, at('2026-10-28 02:00')),
    expected: ok(
      AG,
      fx({
        tasks: [
          {
            op: 'create',
            source: 'next_step',
            kind: 'call',
            assignee: { user: A },
            dueAt: at('2026-10-29 10:00'),
            sourceKey: 'next_step:sweep:card-1:2026-10-28',
          },
        ],
      }),
    ),
  },
  {
    id: 'r29b',
    refs: ['3.5 №29'],
    title: 'Ночная сверка: будущая запись есть — ничего не делается',
    input: inp(AG, { type: 'agreed_sweep', opId: 'op-r29b', facts: { hasFutureBooking: true, hasOpenOwnerTask: false } }, SYS, at('2026-10-28 02:00')),
    expected: ok(AG),
  },

  // ===== № 30. Импорт «Подтвержден» =====
  {
    id: 'r30a',
    refs: ['3.5 №30', '3.6', '12.14'],
    title: 'Импорт «Подтвержден» без найденной записи: «Перезвон: сейчас» и задача «Уточнить договорённость», не agreed',
    input: inp(
      { ...NEW_A, touchedInCrm: false },
      { type: 'import_agreed', opId: 'op-r30a', outcomeKey: 'agreed', occurredAt: at('2026-10-23 18:00'), bookingId: null },
      SYS,
      at('2026-10-24 03:00'),
    ),
    expected: ok(
      {
        ...NEW_A,
        touchedInCrm: false,
        state: 'callback',
        nextCallAt: at('2026-10-24 03:00'),
        lastOutcomeCode: 'agreed',
        lastOutcomeKind: 'agreed',
        lastOutcomeAt: at('2026-10-23 18:00'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-23 18:00'),
        lastConnectAt: at('2026-10-23 18:00'),
        lastTouchAt: at('2026-10-23 18:00'),
        version: 2,
      },
      fx({
        tasks: [
          {
            op: 'create',
            source: 'clarify_import',
            kind: 'call',
            assignee: { user: A },
            dueAt: at('2026-10-24 03:00'),
            sourceKey: 'clarify_import:op-r30a',
          },
        ],
        timeline: [tlCall('op-r30a', at('2026-10-23 18:00'), null, 'agreed', 'new', 'callback')],
      }),
      {
        id: 'op-r30a',
        outcomeCode: 'agreed',
        outcomeKind: 'agreed',
        reasonCode: '',
        lpr: '',
        callbackAt: null,
        callbackPrecision: 'time',
        phoneId: null,
        via: 'import',
        applied: 'applied',
        factReason: '',
        occurredAt: at('2026-10-23 18:00'),
        receivedAt: at('2026-10-24 03:00'),
        userId: null,
        ownerUserIdAtCall: A,
      },
    ),
  },
  {
    id: 'r30b',
    refs: ['3.5 №30', '12.14', 'D-048'],
    title: 'Импорт по карточке, которую уже вели в CRM, — «оставлено как в CRM»',
    input: inp(
      R1,
      { type: 'import_agreed', opId: 'op-r30b', outcomeKey: 'agreed', occurredAt: at('2026-10-23 18:00'), bookingId: null },
      SYS,
      at('2026-10-29 03:00'),
    ),
    expected: reject('touched_in_crm'),
  },
  {
    id: 'r30c',
    refs: ['3.5 №30', '12.39'],
    title: 'Импорт «Подтвержден» вместе с записью из профиля «Записи» → «Договорились», сделка',
    input: inp(
      { ...NEW_A, touchedInCrm: false },
      { type: 'import_agreed', opId: 'op-r30c', outcomeKey: 'agreed', occurredAt: at('2026-10-23 18:00'), bookingId: 'bk-9' },
      SYS,
      at('2026-10-24 03:00'),
    ),
    expected: ok(
      {
        ...NEW_A,
        touchedInCrm: false,
        state: 'agreed',
        isTarget: 'yes',
        lastOutcomeCode: 'agreed',
        lastOutcomeKind: 'agreed',
        lastOutcomeAt: at('2026-10-23 18:00'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-23 18:00'),
        lastConnectAt: at('2026-10-23 18:00'),
        lastTouchAt: at('2026-10-23 18:00'),
        version: 2,
      },
      fx({
        deals: [{ op: 'ensure_open', stage: 'on_agreed', requestId: 'op-r30c' }],
        timeline: [tlCall('op-r30c', at('2026-10-23 18:00'), null, 'agreed', 'new', 'agreed')],
      }),
      {
        id: 'op-r30c',
        outcomeCode: 'agreed',
        outcomeKind: 'agreed',
        reasonCode: '',
        lpr: '',
        callbackAt: null,
        callbackPrecision: 'time',
        phoneId: null,
        via: 'import',
        applied: 'applied',
        factReason: '',
        occurredAt: at('2026-10-23 18:00'),
        receivedAt: at('2026-10-24 03:00'),
        userId: null,
        ownerUserIdAtCall: A,
      },
    ),
  },

  // ===== № 31. Исправление явки =====
  {
    id: 'r31a',
    refs: ['3.5 №31', '5.3', '12.40'],
    title: 'Опоздавший пришёл после «Не пришёл»: «Договорились», задача «перезаписать» закрыта, сделка → on_attended, шаг дальше',
    input: inp(
      NS,
      { type: 'attendance_corrected', opId: 'op-r31a', bookingId: 'bk-1', noShowMarkedAt: at('2026-11-05 15:20'), facts: { hasNextFutureBooking: false } },
      DUTY,
      at('2026-11-05 15:30'),
    ),
    expected: ok(
      { ...AG, version: 7 },
      fx({
        tasks: [
          closeCallbackTasks,
          { op: 'create', source: 'next_step', kind: 'call', assignee: { user: A }, dueAt: at('2026-11-06 10:00'), sourceKey: 'next_step:bk-1' },
        ],
        deals: [
          { op: 'advance', stage: 'on_attended', bookingId: 'bk-1' },
          { op: 'set_needs_rebook', bookingId: 'bk-1', value: false },
        ],
        timeline: [tlState(at('2026-11-05 15:30'), 'u-duty', 'callback', 'agreed', 'attendance_corrected')],
      }),
    ),
  },
  {
    id: 'r31b',
    refs: ['3.5 №31'],
    title: 'После «Не пришёл» уже был более поздний итог — исправление явки карточку не трогает',
    input: inp(
      { ...NS, lastOutcomeAt: at('2026-11-05 16:00') },
      { type: 'attendance_corrected', opId: 'op-r31b', bookingId: 'bk-1', noShowMarkedAt: at('2026-11-05 15:20'), facts: { hasNextFutureBooking: false } },
      LEAD,
      at('2026-11-05 17:00'),
    ),
    expected: reject('stale'),
  },

  // ===== Воронка v2: причины перезвона, касания, точность, неявка, списание, сброс цикла =====
  {
    id: 'v2_reason_required',
    refs: ['pipeline-v2 §4.1'],
    title: 'Перезвон нового контракта без причины при callbackReason.required — reason_required',
    input: inp(NEW_A, oc({ opId: 'op-v2a', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', callbackAt: at('2026-10-30 11:00'), callbackPrecision: 'time' }), OP_A, at('2026-10-29 10:03'), SETTINGS_V2),
    expected: reject('reason_required', 'reasonCode'),
  },
  {
    id: 'v2_reason_unknown',
    refs: ['pipeline-v2 §4.1'],
    title: 'Перезвон с причиной не из группы reasons.callback — reason_unknown',
    input: inp(NEW_A, oc({ opId: 'op-v2b', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', reasonCode: 'too_expensive', callbackAt: at('2026-10-30 11:00'), callbackPrecision: 'time' }), OP_A, at('2026-10-29 10:03'), SETTINGS_V2),
    expected: reject('reason_unknown', 'reasonCode'),
  },
  {
    id: 'v2_reason_system',
    refs: ['pipeline-v2 §4.1'],
    title: 'Системная причина (manual: false) от человека — reason_unknown',
    input: inp(NEW_A, oc({ opId: 'op-v2c', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', reasonCode: 'repeat_sale', callbackAt: at('2026-10-30 11:00'), callbackPrecision: 'time' }), OP_A, at('2026-10-29 10:03'), SETTINGS_V2),
    expected: reject('reason_unknown', 'reasonCode'),
  },
  {
    id: 'v2_reason_unknown_other_group',
    refs: ['pipeline-v2 §4.1'],
    title: 'Причина вне группы проверяется и у «Не интересует»',
    input: inp(NEW_A, oc({ opId: 'op-v2c2', outcomeKey: 'not_interested', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', reasonCode: 'think' }), OP_A, at('2026-10-29 10:03'), SETTINGS_V2),
    expected: reject('reason_unknown', 'reasonCode'),
  },
  {
    id: 'v2_old_contract',
    refs: ['pipeline-v2 §4.4'],
    title: 'Перезвон без callbackPrecision при callbackReason.required — применён по старым правилам: причина пустая, точность time',
    input: inp(NEW_A, oc({ opId: 'op-v2d', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', callbackAt: at('2026-10-30 11:00') }), OP_A, at('2026-10-29 10:03'), SETTINGS_V2),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        nextCallAt: at('2026-10-30 11:00'),
        callbackTouches: 1,
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 10:03'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-29 10:03'),
        lastConnectAt: at('2026-10-29 10:03'),
        lastTouchAt: at('2026-10-29 10:03'),
        version: 2,
      },
      fx({
        tasks: [callbackTask('op-v2d', A, at('2026-10-30 11:00'))],
        timeline: [tlCall('op-v2d', at('2026-10-29 10:03'), A, 'callback', 'new', 'callback')],
      }),
      rec(oc({ opId: 'op-v2d', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', callbackAt: at('2026-10-30 11:00') }), 'callback', A, A),
    ),
  },
  {
    id: 'v2_old_contract_reason',
    refs: ['pipeline-v2 §4.4'],
    title: 'Старый контракт «Перезвонить» с requires.reason и группой причин: причина пишется в звонок, у карточки остаётся пустой',
    input: inp(
      NEW_A,
      oc({ opId: 'op-v2d2', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', reasonCode: 'think', callbackAt: at('2026-10-30 11:00') }),
      OP_A,
      at('2026-10-29 10:03'),
      {
        ...SETTINGS_V2,
        callbackReason: undefined,
        outcomes: SETTINGS_V2.outcomes.map((o) => (o.key === 'callback' ? { ...o, reasonGroup: 'callback', requires: { ...o.requires, reason: true } } : o)),
      },
    ),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        nextCallAt: at('2026-10-30 11:00'),
        callbackTouches: 1,
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 10:03'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-29 10:03'),
        lastConnectAt: at('2026-10-29 10:03'),
        lastTouchAt: at('2026-10-29 10:03'),
        version: 2,
      },
      fx({
        tasks: [callbackTask('op-v2d2', A, at('2026-10-30 11:00'))],
        timeline: [tlCall('op-v2d2', at('2026-10-29 10:03'), A, 'callback', 'new', 'callback')],
      }),
      rec(oc({ opId: 'op-v2d2', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', reasonCode: 'think', callbackAt: at('2026-10-30 11:00') }), 'callback', A, A),
    ),
  },
  {
    id: 'v2_day_precision',
    refs: ['pipeline-v2 §4.2'],
    title: 'Перезвон «в течение дня» с архивной причиной: причина, касание +1, точность day у карточки, звонка и задачи',
    input: inp(NEW_A, oc({ opId: 'op-v2e', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', reasonCode: 'old_think', callbackAt: at('2026-10-30 09:00'), callbackPrecision: 'day' }), OP_A, at('2026-10-29 10:03'), SETTINGS_V2),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        nextCallAt: at('2026-10-30 09:00'),
        nextCallPrecision: 'day',
        callbackReason: 'old_think',
        callbackTouches: 1,
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 10:03'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-29 10:03'),
        lastConnectAt: at('2026-10-29 10:03'),
        lastTouchAt: at('2026-10-29 10:03'),
        version: 2,
      },
      fx({
        tasks: [{ ...callbackTask('op-v2e', A, at('2026-10-30 09:00')), duePrecision: 'day' } as TaskEffect],
        timeline: [tlCall('op-v2e', at('2026-10-29 10:03'), A, 'callback', 'new', 'callback')],
      }),
      rec(oc({ opId: 'op-v2e', outcomeKey: 'callback', occurredAt: at('2026-10-29 10:03'), lpr: 'yes', reasonCode: 'old_think', callbackAt: at('2026-10-30 09:00'), callbackPrecision: 'day' }), 'callback', A, A),
    ),
  },
  {
    id: 'v2_day_today',
    refs: ['pipeline-v2 §4.2'],
    title: 'Срок «время» на начало окна, которое уже прошло, — callback_in_past (для «день» то же допустимо)',
    input: inp(NEW_A, oc({ opId: 'op-v2f', outcomeKey: 'callback', occurredAt: at('2026-10-29 15:00'), lpr: 'yes', reasonCode: 'think', callbackAt: at('2026-10-29 09:00'), callbackPrecision: 'time' }), OP_A, at('2026-10-29 15:00'), SETTINGS_V2),
    expected: reject('callback_in_past', 'callbackAt'),
  },
  {
    id: 'v2_day_today_ok',
    refs: ['pipeline-v2 §4.2'],
    title: 'Срок «день» на сегодня принят',
    input: inp(NEW_A, oc({ opId: 'op-v2g', outcomeKey: 'callback', occurredAt: at('2026-10-29 15:00'), lpr: 'yes', reasonCode: 'think', callbackAt: at('2026-10-29 09:00'), callbackPrecision: 'day' }), OP_A, at('2026-10-29 15:00'), SETTINGS_V2),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        nextCallAt: at('2026-10-29 09:00'),
        nextCallPrecision: 'day',
        callbackReason: 'think',
        callbackTouches: 1,
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-29 15:00'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-29 15:00'),
        lastConnectAt: at('2026-10-29 15:00'),
        lastTouchAt: at('2026-10-29 15:00'),
        version: 2,
      },
      fx({
        tasks: [{ ...callbackTask('op-v2g', A, at('2026-10-29 09:00')), duePrecision: 'day' } as TaskEffect],
        timeline: [tlCall('op-v2g', at('2026-10-29 15:00'), A, 'callback', 'new', 'callback')],
      }),
      rec(oc({ opId: 'op-v2g', outcomeKey: 'callback', occurredAt: at('2026-10-29 15:00'), lpr: 'yes', reasonCode: 'think', callbackAt: at('2026-10-29 09:00'), callbackPrecision: 'day' }), 'callback', A, A),
    ),
  },
  {
    id: 'v2_no_show_reason',
    refs: ['pipeline-v2 §3.3 № 16'],
    title: 'Неявка на групповое: причина no_show_group, касания не меняются',
    input: inp(
      { ...AG, callbackTouches: 0 },
      { type: 'no_show', opId: 'op-v2h', bookingId: 'bk-1', eventType: 'group', facts: { hasOtherFutureBooking: false } },
      DUTY,
      at('2026-11-05 15:20'),
      SETTINGS_V2,
    ),
    expected: ok(
      { ...NS, callbackReason: 'no_show_group' },
      fx({
        tasks: [{ op: 'create', source: 'no_show', kind: 'call', assignee: { user: A }, dueAt: at('2026-11-06 10:00'), sourceKey: 'no_show:bk-1' }],
        deals: [{ op: 'set_needs_rebook', bookingId: 'bk-1', value: true }],
        notifications: [{ kind: 'no_show', to: { user: A }, dedupeKey: null }],
        timeline: [tlState(at('2026-11-05 15:20'), 'u-duty', 'agreed', 'callback', 'no_show')],
      }),
    ),
  },
  {
    id: 'v2_no_show_no_reason',
    refs: ['pipeline-v2 §3.3 № 16'],
    title: 'Неявка на запись вида без системной причины: причина пустая',
    input: inp(
      AG,
      { type: 'no_show', opId: 'op-v2i', bookingId: 'bk-1', eventType: 'individual', facts: { hasOtherFutureBooking: false } },
      DUTY,
      at('2026-11-05 15:20'),
      SETTINGS_V2,
    ),
    expected: ok(
      NS,
      fx({
        tasks: [{ op: 'create', source: 'no_show', kind: 'call', assignee: { user: A }, dueAt: at('2026-11-06 10:00'), sourceKey: 'no_show:bk-1' }],
        deals: [{ op: 'set_needs_rebook', bookingId: 'bk-1', value: true }],
        notifications: [{ kind: 'no_show', to: { user: A }, dedupeKey: null }],
        timeline: [tlState(at('2026-11-05 15:20'), 'u-duty', 'agreed', 'callback', 'no_show')],
      }),
    ),
  },
  {
    id: 'v2_no_show_archived_reason',
    refs: ['pipeline-v2 §3.3 № 16, № 28'],
    title: 'Неявка: системная причина вида только в архиве — причина пустая',
    input: inp(
      AG,
      { type: 'no_show', opId: 'op-v2n', bookingId: 'bk-1', eventType: 'group', facts: { hasOtherFutureBooking: false } },
      DUTY,
      at('2026-11-05 15:20'),
      withSettings({
        reasons: {
          callback: [{ code: 'no_show_group', archived: true, manual: false, system: 'no_show', eventTypes: ['group'] }],
        },
      }),
    ),
    expected: ok(
      NS,
      fx({
        tasks: [{ op: 'create', source: 'no_show', kind: 'call', assignee: { user: A }, dueAt: at('2026-11-06 10:00'), sourceKey: 'no_show:bk-1' }],
        deals: [{ op: 'set_needs_rebook', bookingId: 'bk-1', value: true }],
        notifications: [{ kind: 'no_show', to: { user: A }, dedupeKey: null }],
        timeline: [tlState(at('2026-11-05 15:20'), 'u-duty', 'agreed', 'callback', 'no_show')],
      }),
    ),
  },
  {
    id: 'v2_retry_keeps_cycle',
    refs: ['pipeline-v2 §3.3 (сброс цикла)'],
    title: 'Недозвон после перезвона не сбрасывает причину и касания; точность возвращается к time',
    input: inp(
      { ...CB, callbackReason: 'think', nextCallPrecision: 'day' },
      oc({ opId: 'op-v2j', outcomeKey: 'no_answer', occurredAt: at('2026-10-30 10:00') }),
      OP_A,
      at('2026-10-30 10:00'),
    ),
    expected: ok(
      {
        ...CB,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-30 12:00'),
        callbackReason: 'think',
        callbackTouches: 1,
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-30 10:00'),
        callsTotal: 4,
        noAnswerTotal: 3,
        lastTouchAt: at('2026-10-30 10:00'),
        version: 5,
      },
      fx({
        tasks: [closeCallbackTasks],
        timeline: [tlCall('op-v2j', at('2026-10-30 10:00'), A, 'no_answer', 'callback', 'retry')],
      }),
      rec(oc({ opId: 'op-v2j', outcomeKey: 'no_answer', occurredAt: at('2026-10-30 10:00') }), 'no_answer', A, A),
    ),
  },
  {
    id: 'v2_agreed_resets_cycle',
    refs: ['pipeline-v2 §3.3 (сброс цикла)'],
    title: 'Договорились сбрасывает причину и касания перезвона',
    input: inp(
      { ...CB, callbackReason: 'think', callbackTouches: 2 },
      oc({ opId: 'op-v2k', outcomeKey: 'agreed', occurredAt: at('2026-10-29 15:34'), lpr: 'yes', agreement: { contactId: 'contact-1', bookingId: 'bk-1', agreedDueAt: null } }),
      OP_A,
      at('2026-10-29 15:34'),
    ),
    expected: ok(
      { ...AG, version: 5 },
      fx({
        tasks: [closeCallbackTasks],
        deals: [{ op: 'ensure_open', stage: 'on_agreed', requestId: 'op-v2k' }],
        timeline: [tlCall('op-v2k', at('2026-10-29 15:34'), A, 'agreed', 'callback', 'agreed')],
      }),
      rec(oc({ opId: 'op-v2k', outcomeKey: 'agreed', occurredAt: at('2026-10-29 15:34'), lpr: 'yes', agreement: { contactId: 'contact-1', bookingId: 'bk-1', agreedDueAt: null } }), 'agreed', A, A),
    ),
  },
  {
    id: 'v2_callback_write_off_n5',
    refs: ['pipeline-v2 §3.3 (writeOffEffects)'],
    title: 'Третий недозвон у карточки в перезвоне: «Списан», открытые сделки проиграны системной причиной',
    input: inp({ ...CB, attempts: 2, callbackReason: 'think' }, oc({ opId: 'op-v2l', outcomeKey: 'no_answer', occurredAt: at('2026-10-30 10:00') }), OP_A, at('2026-10-30 10:00'), SETTINGS_V2),
    expected: ok(
      {
        ...CB,
        state: 'written_off',
        attempts: 3,
        nextCallAt: null,
        callbackReason: '',
        callbackTouches: 0,
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-30 10:00'),
        closeReasonCode: 'no_answer_limit',
        closedAt: at('2026-10-30 10:00'),
        callsTotal: 4,
        noAnswerTotal: 3,
        lastTouchAt: at('2026-10-30 10:00'),
        version: 5,
      },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'deal_lost', reasonCode: 'no_show_unreachable' }],
        timeline: [tlCall('op-v2l', at('2026-10-30 10:00'), A, 'no_answer', 'callback', 'written_off')],
      }),
      rec(oc({ opId: 'op-v2l', outcomeKey: 'no_answer', occurredAt: at('2026-10-30 10:00') }), 'no_answer', A, A),
    ),
  },
  {
    id: 'v2_callback_write_off_n7',
    refs: ['pipeline-v2 §3.3 (writeOffEffects)'],
    title: 'Номер не работает, другого нет, карточка в перезвоне: «Списан», сделки проиграны системной причиной',
    input: inp({ ...CB, callbackReason: 'think' }, oc({ opId: 'op-v2m', outcomeKey: 'bad_number', reasonCode: 'not_exists', occurredAt: at('2026-10-30 10:00') }), OP_A, at('2026-10-30 10:00'), SETTINGS_V2),
    expected: ok(
      {
        ...CB,
        state: 'written_off',
        nextCallAt: null,
        callbackReason: '',
        callbackTouches: 0,
        lastOutcomeCode: 'bad_number',
        lastOutcomeKind: 'bad_number',
        lastOutcomeAt: at('2026-10-30 10:00'),
        closeReasonCode: 'no_working_phone',
        closedAt: at('2026-10-30 10:00'),
        callsTotal: 4,
        lastTouchAt: at('2026-10-30 10:00'),
        phones: [PH1_DEAD],
        version: 5,
      },
      fx({
        tasks: [closeAllTasks],
        deals: [{ op: 'lose_open', reasonGroup: 'deal_lost', reasonCode: 'no_show_unreachable' }],
        timeline: [
          tlCall('op-v2m', at('2026-10-30 10:00'), A, 'bad_number', 'callback', 'written_off'),
          tlPhone('phone.not_working', at('2026-10-30 10:00'), A, 'ph-1'),
        ],
      }),
      rec(oc({ opId: 'op-v2m', outcomeKey: 'bad_number', reasonCode: 'not_exists', occurredAt: at('2026-10-30 10:00') }), 'bad_number', A, A),
    ),
  },
  {
    id: 'v2_31_no_open_task',
    refs: ['pipeline-v2 §3.3 № 31'],
    title: 'Исправление явки без открытой задачи неявки (№ 33 без неявки) — stale',
    input: inp(
      NS,
      { type: 'attendance_corrected', opId: 'op-v2n', bookingId: 'bk-1', noShowMarkedAt: at('2026-11-05 15:20'), facts: { hasNextFutureBooking: false, hasOpenNoShowTask: false } },
      DUTY,
      at('2026-11-05 15:30'),
    ),
    expected: reject('stale'),
  },

  // ===== §12. Граничные случаи итогов =====
  {
    id: 'e12_1a',
    refs: ['12.1', '3.5 (версия)'],
    title: 'Итог владельца старше итога временного владельца: записан фактом (stale), состояние не меняется',
    input: inp({ ...R2, actingUserId: B, actingUntilDay: '2026-10-28' }, E121A, OP_A, E121A.receivedAt),
    expected: fact(
      'stale',
      { ...R2, actingUserId: B, actingUntilDay: '2026-10-28', callsTotal: 3, noAnswerTotal: 3, version: 4 },
      rec(E121A, 'no_answer', A, A, { applied: 'fact_only', factReason: 'stale' }),
      fx({ timeline: [tlCall('op-e12_1a', at('2026-10-28 12:10'), A, 'no_answer', 'retry', 'retry', 'stale')] }),
    ),
  },
  {
    id: 'e12_1b',
    refs: ['12.1', '3.5 №12'],
    title: 'Устаревший «Полный отказ» записан фактом, но руководитель получает задачу проверить просьбу не звонить',
    input: inp({ ...R2, actingUserId: B, actingUntilDay: '2026-10-28' }, E121B, OP_A, E121B.receivedAt),
    expected: fact(
      'stale',
      {
        ...R2,
        actingUserId: B,
        actingUntilDay: '2026-10-28',
        callsTotal: 3,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-28 12:10'),
        lastConnectAt: at('2026-10-28 12:10'),
        version: 4,
      },
      rec(E121B, 'do_not_call', A, A, { applied: 'fact_only', factReason: 'stale' }),
      fx({
        tasks: [{ op: 'create', source: 'review', kind: 'check', assignee: { role: 'lead' }, dueAt: null, sourceKey: 'review:op-e12_1b' }],
        timeline: [tlCall('op-e12_1b', at('2026-10-28 12:10'), A, 'do_not_call', 'retry', 'retry', 'stale')],
      }),
    ),
  },
  {
    id: 'e12_2',
    refs: ['12.2', '12.8', 'D-019'],
    title: 'Повтор итога из офлайн-очереди с тем же opId: ничего не меняется, возвращается первый результат',
    input: inp(
      R1,
      oc({
        opId: 'op-r04a',
        outcomeKey: 'no_answer',
        via: 'offline',
        occurredAt: at('2026-10-28 10:14'),
        receivedAt: at('2026-10-28 10:30'),
        facts: { sameOpId: { applied: 'applied', factReason: '' }, actorWasOwnerAtCall: true },
      }),
      OP_A,
      at('2026-10-28 10:30'),
    ),
    expected: { status: 'duplicate', applied: 'applied', factReason: '' },
  },
  {
    id: 'e12_3a',
    refs: ['12.3'],
    title: 'Офлайн-недозвон пришёл через 3 часа: повтор от времени звонка (12:14), срок уже прошёл — карточка сразу в очереди',
    input: inp(NEW_A, E123A, OP_A, E123A.receivedAt),
    expected: ok(
      R1,
      fx({ timeline: [tlCall('op-e12_3a', at('2026-10-28 10:14'), A, 'no_answer', 'new', 'retry')] }),
      rec(E123A, 'no_answer', A, A),
    ),
  },
  {
    id: 'e12_3b',
    refs: ['12.3', 'CONFIG 6.5'],
    title: 'Время звонка старше 72 ч до приёма ограничивается окном (вт 20.10 10:00), предупреждение',
    input: inp(NEW_A, E123B, OP_A, E123B.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-20 12:00'),
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-20 10:00'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-20 10:00'),
        version: 2,
      },
      fx({ timeline: [tlCall('op-e12_3b', at('2026-10-20 10:00'), A, 'no_answer', 'new', 'retry')] }),
      rec(E123B, 'no_answer', A, A, { occurredAt: at('2026-10-20 10:00') }),
      ['occurred_at_clamped'],
    ),
  },
  {
    id: 'e12_3c',
    refs: ['12.3'],
    title: 'Часы устройства спешат на 10 минут: время звонка ограничено приёмом + 5 минут',
    input: inp(NEW_A, E123C, OP_A, E123C.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-28 12:25'),
        lastOutcomeCode: 'no_answer',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-28 10:25'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-28 10:25'),
        version: 2,
      },
      fx({ timeline: [tlCall('op-e12_3c', at('2026-10-28 10:25'), A, 'no_answer', 'new', 'retry')] }),
      rec(E123C, 'no_answer', A, A, { occurredAt: at('2026-10-28 10:25') }),
      ['occurred_at_clamped'],
    ),
  },
  {
    id: 'e12_4a',
    refs: ['12.4', '3.5 (версия)'],
    title: 'Офлайн-итог по карточке, где руководитель поправил поле (версия выросла): итог применяется',
    input: inp({ ...R1, version: 7 }, E124A, OP_A, E124A.receivedAt),
    expected: ok(
      { ...R2, version: 8 },
      fx({ timeline: [tlCall('op-e12_4a', at('2026-10-28 12:20'), A, 'no_answer', 'retry', 'retry')] }),
      rec(E124A, 'no_answer', A, A),
    ),
  },
  {
    id: 'e12_4b',
    refs: ['12.4', '3.5 (версия)'],
    title: 'Офлайн-итог «Не интересует» по карточке, которая уже «Договорились»: переход недопустим — факт (stale)',
    input: inp(AG, E124B, OP_A, E124B.receivedAt),
    expected: fact(
      'stale',
      { ...AG, callsTotal: 5, connectsTotal: 3, lastConnectAt: at('2026-10-29 16:00'), lastTouchAt: at('2026-10-29 16:00'), version: 6 },
      rec(E124B, 'not_interested', A, A, { applied: 'fact_only', factReason: 'stale' }),
      fx({ timeline: [tlCall('op-e12_4b', at('2026-10-29 16:00'), A, 'not_interested', 'agreed', 'agreed', 'stale')] }),
    ),
  },
  {
    id: 'e12_5a',
    refs: ['12.5', '12.16', '8.5'],
    title: 'Офлайн-итог после передачи карточки: факт «до передачи», новому владельцу задача проверить итог',
    input: inp({ ...CB, ownerUserId: B }, E125A, OP_A, E125A.receivedAt),
    expected: fact(
      'owner_changed',
      { ...CB, ownerUserId: B, callsTotal: 4, noAnswerTotal: 3, lastTouchAt: at('2026-10-29 15:34'), version: 5 },
      rec(E125A, 'no_answer', A, A, { applied: 'fact_only', factReason: 'owner_changed' }),
      fx({
        tasks: [{ op: 'create', source: 'review', kind: 'check', assignee: { user: B }, dueAt: null, sourceKey: 'review:op-e12_5a' }],
        timeline: [tlCall('op-e12_5a', at('2026-10-29 15:34'), A, 'no_answer', 'callback', 'callback', 'owner_changed')],
      }),
    ),
  },
  {
    id: 'e12_5b',
    refs: ['12.5', '8.3'],
    title: 'Итог по чужой карточке, которой оператор никогда не владел: как несуществующая (404)',
    input: inp(
      { ...CB, ownerUserId: B },
      oc({
        opId: 'op-e12_5b',
        outcomeKey: 'no_answer',
        occurredAt: at('2026-10-29 15:34'),
        facts: { sameOpId: null, actorWasOwnerAtCall: false },
      }),
      OP_A,
      at('2026-10-29 15:34'),
    ),
    expected: reject('not_found'),
  },
  {
    id: 'e12_9',
    refs: ['12.9', '12.3'],
    title: 'Офлайн-перезвон на 11:00 пришёл в 13:00: допуск считается от времени звонка — принят, карточка сразу в очереди',
    input: inp(NEW_A, E129, OP_A, E129.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'callback',
        callbackTouches: 1,
        nextCallAt: at('2026-10-28 11:00'),
        lpr: 'yes',
        lastOutcomeCode: 'callback',
        lastOutcomeKind: 'callback',
        lastOutcomeAt: at('2026-10-28 10:00'),
        callsTotal: 1,
        connectsTotal: 1,
        firstConnectAt: at('2026-10-28 10:00'),
        lastConnectAt: at('2026-10-28 10:00'),
        lastTouchAt: at('2026-10-28 10:00'),
        version: 2,
      },
      fx({
        tasks: [callbackTask('op-e12_9', A, at('2026-10-28 11:00'))],
        timeline: [tlCall('op-e12_9', at('2026-10-28 10:00'), A, 'callback', 'new', 'callback')],
      }),
      rec(E129, 'callback', A, A),
    ),
  },
  {
    id: 'e12_31a',
    refs: ['12.31'],
    title: 'Архивный итог в пределах 72 ч после архивации принимается по своему виду',
    input: inp(NEW_A, E1231A, OP_A, E1231A.receivedAt),
    expected: ok(
      {
        ...NEW_A,
        state: 'retry',
        attempts: 1,
        nextCallAt: at('2026-10-28 12:00'),
        lastOutcomeCode: 'legacy_busy',
        lastOutcomeKind: 'no_answer',
        lastOutcomeAt: at('2026-10-28 10:00'),
        callsTotal: 1,
        noAnswerTotal: 1,
        lastTouchAt: at('2026-10-28 10:00'),
        version: 2,
      },
      fx({ timeline: [tlCall('op-e12_31a', at('2026-10-28 10:00'), A, 'no_answer', 'new', 'retry')] }),
      rec(E1231A, 'no_answer', A, A),
    ),
  },
  {
    id: 'e12_31b',
    refs: ['12.31'],
    title: 'Архивный итог, принятый позже 72 ч после архивации, отклоняется',
    input: inp(
      NEW_A,
      oc({
        opId: 'op-e12_31b',
        outcomeKey: 'legacy_busy',
        via: 'offline',
        occurredAt: at('2026-10-30 17:00'),
        receivedAt: at('2026-10-31 10:00'),
      }),
      OP_A,
      at('2026-10-31 10:00'),
    ),
    expected: reject('outcome_archived', 'outcomeKey'),
  },
  {
    id: 'e_unknown',
    refs: ['3.2', 'CONFIG 6.5'],
    title: 'Неизвестный код итога отклоняется',
    input: inp(NEW_A, oc({ opId: 'op-e_unknown', outcomeKey: 'nope', occurredAt: at('2026-10-28 10:00') }), OP_A, at('2026-10-28 10:00')),
    expected: reject('outcome_unknown', 'outcomeKey'),
  },
  {
    id: 'e_acting',
    refs: ['3.5 (кто: О)', '7.5', 'D-041'],
    title: 'Итог ставит временный владелец: применяется; в звонке — автор и владелец на момент звонка',
    input: inp({ ...R1, actingUserId: B, actingUntilDay: '2026-10-30' }, E_ACT, OP_B, E_ACT.receivedAt),
    expected: ok(
      { ...R2, actingUserId: B, actingUntilDay: '2026-10-30' },
      fx({ timeline: [tlCall('op-e_acting', at('2026-10-28 12:20'), B, 'no_answer', 'retry', 'retry')] }),
      rec(E_ACT, 'no_answer', B, A),
    ),
  },
  {
    id: 'e_forbidden',
    refs: ['8.2'],
    title: 'Итог звонка от роли с охватом «по отношению» (консультант) — запрещено',
    input: inp(AG, oc({ opId: 'op-e_forbidden', outcomeKey: 'no_answer', occurredAt: at('2026-10-30 10:00') }), CONS, at('2026-10-30 10:00')),
    expected: reject('forbidden'),
  },
];
