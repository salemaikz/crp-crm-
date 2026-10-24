// Что показывает плитка лида (pipeline-v2 §9.3, §5.3): чистые функции без React, чтобы раскладку проверяли юнит-тесты.
import type { BoardCardDto } from './types';

export type Tone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';
const TONES: readonly Tone[] = ['success', 'warning', 'info', 'danger', 'neutral'];

/**
 * Тон плитки по `board.tones` (§5.3): первое совпавшее условие. Неизвестное имя тона или условие пропускаются, чтобы
 * ошибка пресета не ломала экран. Покупка считается только если сервер прислал признак (`purchases` есть).
 */
export function toneOf(card: BoardCardDto, tones: readonly { when: string; tone: string }[]): Tone | null {
  for (const t of tones) {
    if (!(TONES as readonly string[]).includes(t.tone)) continue;
    const hit =
      t.when === 'attendedIndividual' ? card.flags.attendedIndividual
      : t.when === 'attendedGroup' ? card.flags.attendedGroup
      : t.when === 'noShow' ? card.flags.noShow
      : t.when === 'purchased' ? (card.purchases?.total ?? 0) > 0
      : false;
    if (hit) return t.tone as Tone;
  }
  return null;
}

export type BadgeId = 'attendedGroup' | 'attendedIndividual' | 'purchased' | 'noShow';

/** Значки признаков: «был на встрече», «был на консультации», «покупал» (только при праве), «не пришёл». */
export function badgesOf(card: BoardCardDto): BadgeId[] {
  const out: BadgeId[] = [];
  if (card.flags.attendedGroup) out.push('attendedGroup');
  if (card.flags.attendedIndividual) out.push('attendedIndividual');
  if (card.purchases !== undefined && card.purchases.total > 0) out.push('purchased');
  if (card.flags.noShow) out.push('noShow');
  return out;
}

export type ChipView =
  | { kind: 'reason'; reason: string; touches: number }
  | { kind: 'attempts'; n: number }
  | { kind: 'event'; type: string; status: string; startsAt: number }
  | { kind: 'state'; state: string }
  | { kind: 'none' };

/** Чип под названием: причина перезвона и касание, недозвон, запись или просто состояние. */
export function chipOf(card: BoardCardDto): ChipView {
  if (card.state === 'agreed' && card.event) return { kind: 'event', type: card.event.type, status: card.event.status, startsAt: card.event.startsAt };
  if (card.state === 'callback' && card.callbackReason !== '') return { kind: 'reason', reason: card.callbackReason, touches: card.callbackTouches };
  if (card.state === 'retry' && card.attempts > 0) return { kind: 'attempts', n: card.attempts };
  if (card.state === 'callback') return { kind: 'state', state: 'callback' };
  if (card.state === 'new') return { kind: 'none' };
  return { kind: 'state', state: card.state };
}

/** Подпись причины перезвона из справочника; кода нет в справочнике (старый или служебный) — null, сырой ключ не показываем. */
export function reasonLabel(labels: Readonly<Record<string, string>>, code: string): string | null {
  const v = Object.hasOwn(labels, code) ? labels[code] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export type DueView =
  | { kind: 'none' }
  | { kind: 'overdue'; precision: 'time' | 'day'; at: number; minutes: number }
  | { kind: 'today'; precision: 'time' | 'day'; at: number }
  | { kind: 'later'; precision: 'time' | 'day'; at: number };

/** Срок перезвона: просрочка и «сегодня» берутся от сервера (`fire`, одно правило, §4.3), здесь только форма показа. */
export function dueOf(card: BoardCardDto, now: number): DueView {
  if (card.nextCallAt === null) return { kind: 'none' };
  const precision = card.nextCallPrecision;
  if (card.fire === 'overdue') return { kind: 'overdue', precision, at: card.nextCallAt, minutes: Math.max(1, Math.round((now - card.nextCallAt) / 60_000)) };
  if (card.fire === 'today') return { kind: 'today', precision, at: card.nextCallAt };
  return { kind: 'later', precision, at: card.nextCallAt };
}

/** Огонёк: перезвон на сегодня или просрочен. */
export const hasFire = (card: BoardCardDto): boolean => card.fire === 'today' || card.fire === 'overdue';

/** Просрочка словами: «2 ч» / «35 мин» / «3 д». */
export function overdueParts(minutes: number): { unit: 'min' | 'hour' | 'day'; n: number } {
  if (minutes < 60) return { unit: 'min', n: minutes };
  if (minutes < 60 * 24) return { unit: 'hour', n: Math.round(minutes / 60) };
  return { unit: 'day', n: Math.round(minutes / (60 * 24)) };
}
