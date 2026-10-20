// Дневной лимит на оператора (PROCESS 7.3). Исправление ошибки SalemAI: там лимит считал только
// авто-выдачу, ручная раздача и возвраты его обходили. Здесь в лимит входят все виды из
// `distribution.capIncludes` (пилотная настройка: авто, ручная, возвраты «Не интересует» через 90 дней).

import type { DistributionSettings, IssueKind, Participant } from './types';

/** Сколько из лимита уже израсходовано: сумма выдач тех видов, что входят в лимит. */
export function capUsed(
  issuedToday: Readonly<Partial<Record<IssueKind, number>>>,
  capIncludes: readonly IssueKind[],
): number {
  let used = 0;
  for (const kind of new Set(capIncludes)) used += Math.max(0, issuedToday[kind] ?? 0);
  return used;
}

/** Остаток лимита сегодня (не меньше нуля). «Вернуть в пул» лимит не восстанавливает — в журнале выдача остаётся. */
export function capRemaining(p: Pick<Participant, 'issuedToday'>, s: Pick<DistributionSettings, 'dailyCap' | 'capIncludes'>): number {
  return Math.max(0, s.dailyCap - capUsed(p.issuedToday, s.capIncludes));
}

export type ManualIssueReason = 'not_working' | 'over_cap';

export interface ManualIssueCheck {
  ok: boolean;
  /** Сколько можно выдать сверх (для сообщения «осталось 0 из 40, раздадим завтра»). */
  remaining: number;
  cap: number;
  reason?: ManualIssueReason;
}

/**
 * Можно ли РОП выдать `count` карточек вручную. Сверх остатка не проходит (в пилотной настройке превышение
 * запрещено), если только `capOverride`. Если ручная выдача не входит в `capIncludes`, лимит её
 * не ограничивает. «Пауза» и «Отсутствует» новых не получают.
 */
export function checkManualIssue(
  p: Pick<Participant, 'status' | 'issuedToday'>,
  count: number,
  s: Pick<DistributionSettings, 'dailyCap' | 'capIncludes' | 'capOverride'>,
): ManualIssueCheck {
  const remaining = capRemaining(p, s);
  const base = { remaining, cap: s.dailyCap };
  if (p.status !== 'working') return { ...base, ok: false, reason: 'not_working' };
  if (!s.capIncludes.includes('manual') || s.capOverride) return { ...base, ok: true };
  return count <= remaining ? { ...base, ok: true } : { ...base, ok: false, reason: 'over_cap' };
}
