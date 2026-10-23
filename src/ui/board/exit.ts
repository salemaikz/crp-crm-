// Выход из «Договорились» (№ 33, pipeline-v2 §3.3–§3.4): подстановка причины и срока по явке, тело запроса, ответы сервера.
// Чистые функции без React. Решение принимает сервер (ядро, одна транзакция с явкой); здесь только подсказки окна.
import { resolvePreset } from '@/ui/call/callback';
import { dueFor, scheduleHint, type CallbackPrecision } from '@/ui/call/callbackPlan';
import type { CallConfig, CallbackPreset } from '@/ui/call/types';
import type { ExitAttendance } from './attend';
import type { AgreedExitConfig, BoardCardDto, BoardColumnConfig, BoardReason } from './types';
import type { TrashChoice } from './moves';

export type ExitTo = 'callback' | 'not_interested' | 'written_off';

export interface Due {
  at: number;
  precision: CallbackPrecision;
}

/**
 * Причина по явке: «Не пришёл» → причина неявки вида записи, «Пришёл» → «пришёл, не купил». Подставляется, только если
 * такая ручная причина есть среди предложенных; иначе пусто (оператор выберет сам).
 */
export function autoReason(att: ExitAttendance, card: BoardCardDto, cfg: AgreedExitConfig, available: readonly { key: string }[]): string {
  const key = att === 'no_show' ? (card.event ? cfg.noShowReasons[card.event.type] : undefined) : att === 'attended' ? (cfg.attendedReason ?? undefined) : undefined;
  return key !== undefined && available.some((r) => r.key === key) ? key : '';
}

/** Срок по явке: после неявки — шаг `booking.noShow.callbackAt`, иначе — подсказка по номеру касания; нет ни того, ни другого — null. */
export function autoDue(att: ExitAttendance, card: BoardCardDto, cfg: AgreedExitConfig, call: CallConfig, now: number): Due | null {
  if (att === 'no_show' && cfg.noShowCallback) return dueOfPreset(cfg.noShowCallback, call, now);
  if (!call.callbackSchedule) return null;
  const hint = scheduleHint({ steps: call.callbackSchedule, touches: card.callbackTouches, now, tz: call.timeZone, cal: call.calendar });
  return hint ? dueFor(hint.day, hint.time, call.callWindowStart, call.timeZone) : null;
}

function dueOfPreset(p: CallbackPreset, call: CallConfig, now: number): Due {
  return { at: resolvePreset(p, now, call.timeZone, call.calendar).at, precision: 'time' };
}

export interface ExitInput {
  opId: string;
  card: BoardCardDto;
  to: ExitTo;
  reasonCode: string;
  reasonText: string;
  due: Due | null;
  attendance: { bookingId: string; to: 'attended' | 'no_show' } | null;
}

/** Тело `POST /api/cards/[id]/move` (MoveBody, строгая схема): лишних ключей нет. */
export function exitBody(i: ExitInput): Record<string, unknown> {
  const text = i.reasonText.trim();
  return {
    opId: i.opId,
    version: i.card.version,
    to: i.to,
    reasonCode: i.reasonCode,
    ...(text !== '' ? { reasonText: text } : {}),
    ...(i.to === 'callback' && i.due ? { callbackAt: i.due.at, callbackPrecision: i.due.precision } : {}),
    ...(i.to === 'callback' && i.attendance ? { attendance: i.attendance } : {}),
  };
}

export type ExitOutcome = 'ok' | 'gone' | 'readOnly' | 'forbidden' | 'changed' | 'invalid' | 'failed';

/** Ответ сервера → что показать: 404 «Карточка недоступна», 423 «только чтение», 409 «доска обновлена», 400 — поле. */
export function exitOutcome(status: number): ExitOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404) return 'gone';
  if (status === 423) return 'readOnly';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'changed';
  if (status === 400) return 'invalid';
  return 'failed';
}

const TRASH_KINDS = ['not_interested', 'written_off'] as const;

/**
 * Причины «Мусора» для выхода из «Договорились»: только «Не интересует» и списание (№ 33); «Не целевой» и «Не звонить»
 * закрываются из меню карточки. Быстрые — из `drop` колонки, остальные — по «Другие причины…». Блокировки «сначала
 * позвоните» нет: у договорённости звонок уже был.
 */
export function exitTrashChoices(column: BoardColumnConfig, call: CallConfig, writeOff: readonly BoardReason[]): { quick: TrashChoice[]; more: TrashChoice[] } {
  const notInterested = call.outcomes.find((o) => o.kind === 'not_interested');
  const mk = (kind: string, reason: string, fallbackLabel: string): TrashChoice | null => {
    if (kind === 'not_interested') {
      const r = notInterested?.reasons.find((x) => x.key === reason);
      return r ? { kind: 'outcome', outcomeKind: 'not_interested', reason, label: r.label, needsText: r.needsText } : null;
    }
    if (kind === 'written_off') {
      const r = writeOff.find((x) => x.key === reason);
      return { kind: 'write_off', reason, label: r?.label ?? fallbackLabel, needsText: false, blocked: null };
    }
    return null;
  };
  const quick: TrashChoice[] = [];
  for (const d of column.drop) {
    if (!(TRASH_KINDS as readonly string[]).includes(d.kind)) continue;
    // Причина с текстом у списания в тело не помещается: пропускаем, как на доске (moves.quickTrash)
    if (d.kind === 'written_off' && writeOff.find((x) => x.key === d.reason)?.needsText) continue;
    const c = mk(d.kind, d.reason, d.label);
    if (c) quick.push(c);
  }
  if (!column.dropMore) return { quick, more: [] };
  const seen = new Set(quick.map((c) => `${c.kind}:${c.reason}`));
  const more: TrashChoice[] = [];
  for (const r of notInterested?.reasons ?? []) if (!seen.has(`outcome:${r.key}`)) more.push({ kind: 'outcome', outcomeKind: 'not_interested', reason: r.key, label: r.label, needsText: r.needsText });
  for (const r of writeOff) if (!r.needsText && !seen.has(`write_off:${r.key}`)) more.push({ kind: 'write_off', reason: r.key, label: r.label, needsText: false, blocked: null });
  return { quick, more };
}

/** Цель выхода по выбору в «Мусоре». */
export const exitToOf = (c: TrashChoice): ExitTo => (c.kind === 'write_off' ? 'written_off' : 'not_interested');

export interface ExitPlan {
  column: string;
  patch: Partial<BoardCardDto>;
}

/** Куда плитка переедет на экране сразу после подтверждения (до ответа сервера); окончательно решает сервер. */
export function planExit(card: BoardCardDto, to: ExitTo, reasonCode: string, due: Due | null, columns: readonly BoardColumnConfig[], now: number): ExitPlan | null {
  if (to === 'callback') {
    const col = columns.find((c) => c.role === 'callback');
    if (!col || !due) return null;
    return { column: col.key, patch: { state: 'callback', attempts: 0, callbackReason: reasonCode, callbackTouches: card.callbackTouches + 1, nextCallAt: due.at, nextCallPrecision: due.precision, fire: null, event: null } };
  }
  const col = columns.find((c) => c.role === 'trash');
  if (!col) return null;
  return { column: col.key, patch: { state: to, closedAt: now, closeReasonCode: reasonCode, nextCallAt: null, fire: null, event: null } };
}

/** Настройки для листа причин выхода: у № 33 нет ЛПР, полей итога и контакта (тело `move` их не принимает). */
export function exitCallConfig(call: CallConfig): CallConfig {
  return { ...call, lprRequiredOnContact: false, outcomes: call.outcomes.map((o) => ({ ...o, requires: { ...o.requires, lpr: false, contact: false, fields: [] } })) };
}
