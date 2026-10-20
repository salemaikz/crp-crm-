// Состояние карточки из итога таблицы (дизайн C4d §7.3, D-115). Чистая функция: время и календарь
// приходят параметрами, БД нет. По плану написан бы core/import/cardPlan.ts (задача C4-core); пока
// живёт здесь и вызывает ядро для «Подтвержден» (calling.applyOutcome, import_agreed, вектор № 30).
// Итоги, которые таблица не умеет выразить (ниша, причины), не выдумываются.
import { calling } from '@crm/core';

type Snapshot = calling.CardSnapshot;
type CallingSettings = calling.CallingSettings;
type OutcomeKind = calling.OutcomeKind;

const DAY_MS = 86_400_000;
const { CONNECTED_KINDS, OUTCOME_ALLOWED_FROM } = calling;
/** Состояния, в которых карточка без владельца недопустима (D-066). */
const WORKING_RESULT = new Set<string>(['retry', 'callback', 'agreed']);

export interface PlanInput {
  /** Текущая карточка; для новой — пустая (`blankCard`). */
  card: Snapshot;
  row: { outcomeKey: string | null; outcomeKind: string | null; lpr: 'yes' | 'no' | '' | null; target: 'target' | 'non_target' | '' | null };
  /** Строка задержана или без владельца: рабочий итог не применяется (карточка встаёт «новой»). */
  held: boolean;
  /** Рабочих номеров у клиента (для «Недоступен»). */
  workingPhones: number;
  settings: CallingSettings;
  calendar: calling.WorkCalendar;
  /** Момент звонка по таблице: день снимка 18:00, но не позже now. */
  occurredAt: number;
  now: number;
  /** `rowKey:stateKey` — ключ звонка, на нём строятся ключи задач. */
  importKey: string;
}

export interface PlannedCall {
  outcomeCode: string;
  outcomeKind: OutcomeKind;
  lpr: 'yes' | 'no' | '';
  occurredAt: number;
  applied: 'applied' | 'fact_only';
  factReason: '' | 'stale';
}

export interface PlanEffects {
  /** Задача-перезвон владельцу (D-050). */
  callbackTask: boolean;
  /** Задача «Уточнить договорённость» (№ 30). */
  clarifyTask: boolean;
  /** Закрыть открытые задачи клиента: все (закрытое состояние) или только проекцию перезвона. */
  closeTasks: 'all' | 'callback' | null;
  /** «Полный отказ»: рабочие номера клиента — в стоп-лист. */
  stopListAllWorking: boolean;
  /** «Недоступен» при единственном рабочем номере: номер нерабочий. */
  singlePhoneNotWorking: boolean;
  /** Замечания строки: `bad_number_ambiguous`, `non_target_without_outcome`, `outcome_stale`. */
  flags: string[];
}

export interface CardPlan {
  card: Snapshot;
  call: PlannedCall | null;
  effects: PlanEffects;
  /** Итог не применён: строка задержана или без владельца, итог остаётся только в ленте. */
  deferred: boolean;
}

/** Пустая карточка нового клиента (состояние «новая», счётчики нули). */
export function blankCard(id: string, clientId: string, ownerUserId: string | null, holdReason: Snapshot['holdReason']): Snapshot {
  return {
    id,
    clientId,
    ownerUserId,
    actingUserId: null,
    actingUntilDay: '',
    state: 'new',
    holdReason,
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
    version: 0,
    phones: [],
  };
}

const noEffects = (): PlanEffects => ({
  callbackTask: false,
  clarifyTask: false,
  closeTasks: null,
  stopListAllWorking: false,
  singlePhoneNotWorking: false,
  flags: [],
});

function isOutcomeKind(k: string | null): k is OutcomeKind {
  return k !== null && Object.hasOwn(OUTCOME_ALLOWED_FROM, k);
}

export function planImportedCard(i: PlanInput): CardPlan {
  const { card, row, settings, occurredAt: t, now } = i;
  const effects = noEffects();
  // Колонки ЛПР и «Целевой»: пусто не равно «нет»; «Не целевой» без итога «Не целевой» не ставится (D-036)
  let flagged: Snapshot = card;
  if (row.lpr === 'yes' || row.lpr === 'no') flagged = { ...flagged, lpr: row.lpr };
  if (row.target === 'target' && flagged.isTarget === '') flagged = { ...flagged, isTarget: 'yes' };
  if (row.target === 'non_target' && row.outcomeKind !== 'not_target') effects.flags.push('non_target_without_outcome');

  const key = row.outcomeKey;
  const kind = row.outcomeKind;
  if (!key || !isOutcomeKind(kind)) return { card: flagged, call: null, effects, deferred: false };

  const plannedCall = (k: OutcomeKind, applied: PlannedCall['applied'], factReason: PlannedCall['factReason']): PlannedCall => ({
    outcomeCode: key,
    outcomeKind: k,
    lpr: row.lpr === 'yes' || row.lpr === 'no' ? row.lpr : '',
    occurredAt: t,
    applied,
    factReason,
  });
  const connect = (CONNECTED_KINDS as readonly string[]).includes(kind);
  const counters = (c: Snapshot): Partial<Snapshot> => ({
    callsTotal: c.callsTotal + 1,
    connectsTotal: c.connectsTotal + (connect ? 1 : 0),
    noAnswerTotal: c.noAnswerTotal + (kind === 'no_answer' ? 1 : 0),
    firstConnectAt: connect ? Math.min(c.firstConnectAt ?? t, t) : c.firstConnectAt,
    lastConnectAt: connect ? Math.max(c.lastConnectAt ?? t, t) : c.lastConnectAt,
    lastTouchAt: Math.max(c.lastTouchAt ?? t, t),
  });
  const outcomeFields = { lastOutcomeCode: key, lastOutcomeKind: kind, lastOutcomeAt: t };

  // Итог из таблицы неприменим из текущего состояния (например, «Перезвонить» у закрытой карточки): факт без перехода
  if (!OUTCOME_ALLOWED_FROM[kind].includes(card.state)) {
    effects.flags.push('outcome_stale');
    return { card: { ...flagged, ...counters(card) }, call: plannedCall(kind, 'fact_only', 'stale'), effects, deferred: false };
  }

  const leave = (to: Snapshot['state']): void => {
    if (['not_interested', 'not_target', 'do_not_call', 'written_off'].includes(to)) effects.closeTasks = 'all';
    else if (card.state === 'callback') effects.closeTasks = 'callback';
  };
  const done = (patch: Partial<Snapshot>, call: PlannedCall = plannedCall(kind, 'applied', '')): CardPlan => {
    const next: Snapshot = { ...flagged, ...counters(card), ...outcomeFields, ...patch };
    leave(next.state);
    // Рабочий итог у задержанной или бесхозной строки не применяется (D-115, D-066)
    if (i.held && WORKING_RESULT.has(next.state)) {
      return { card: flagged, call: null, effects: { ...noEffects(), flags: effects.flags }, deferred: true };
    }
    return { card: next, call, effects, deferred: false };
  };

  switch (kind) {
    case 'no_answer': {
      const attempts = card.attempts + 1;
      if (attempts >= settings.retry.maxAttempts) {
        return done({ state: 'written_off', attempts, nextCallAt: null, closeReasonCode: 'no_answer_limit', closedAt: t });
      }
      return done({ state: 'retry', attempts, nextCallAt: now });
    }
    case 'bad_number': {
      if (i.workingPhones <= 1) {
        effects.singlePhoneNotWorking = true;
        return done({ state: 'written_off', nextCallAt: null, closeReasonCode: 'no_working_phone', closedAt: t });
      }
      effects.flags.push('bad_number_ambiguous');
      return done({ state: 'retry', nextCallAt: now });
    }
    case 'callback':
      effects.callbackTask = true;
      return done({ state: 'callback', attempts: 0, nextCallAt: now });
    case 'agreed': {
      // Вектор № 30: «Подтвержден» без записи → «Перезвон: сейчас» и задача «Уточнить договорённость»
      const r = calling.applyOutcome({
        card: { ...flagged },
        event: { type: 'import_agreed', opId: i.importKey, outcomeKey: key, occurredAt: t, bookingId: null },
        actor: { userId: null, kind: 'system', scope: 'space' },
        now,
        settings,
        calendar: i.calendar,
      });
      if (r.status !== 'applied') {
        effects.flags.push('outcome_stale');
        return { card: { ...flagged, ...counters(card) }, call: plannedCall(kind, 'fact_only', 'stale'), effects, deferred: false };
      }
      effects.clarifyTask = r.effects.tasks.some((x) => x.op === 'create' && x.source === 'clarify_import');
      return done({ state: r.card.state, attempts: r.card.attempts, nextCallAt: r.card.nextCallAt, isTarget: r.card.isTarget });
    }
    case 'not_interested': {
      const days = settings.returnDays.not_interested;
      return done({ state: 'not_interested', nextCallAt: null, returnAt: days === null ? null : t + days * DAY_MS, closedAt: t });
    }
    case 'not_target':
      return done({ state: 'not_target', nextCallAt: null, isTarget: 'no', closedAt: t });
    case 'do_not_call':
      effects.stopListAllWorking = true;
      return done({ state: 'do_not_call', nextCallAt: null, closedAt: t });
  }
}
