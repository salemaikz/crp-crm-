// Итоговый отчёт по клиенту (C8, PROCESS 9.3, docs/tasks-team-design.md §3.4): структура без текста, только то,
// что зрителю видно. Фразу строит интерфейс из локали. Счётчики звонков — с карточки, без пересчёта (PROCESS 9.2).
import type { Viewer } from '@/server/access';
import { seesDealsOnlyAsDepartment } from '@/server/domain/deals/visibility';
import { getDb } from '@/server/platform/db';
import { selectSummaryParts } from './repo';
import type { ClientSummaryDto, NextStepKind } from './types';

/** Данные карточки обзвона, нужные отчёту (передаёт сервис клиентов, чтобы не читать карточку второй раз). */
export type SummaryCard = {
  state: string;
  nextCallAt: number | null;
  callsTotal: number;
  connectsTotal: number;
  noAnswerTotal: number;
  ownerName: string | null;
  actingName: string | null;
};

type NextStep = ClientSummaryDto['nextStep'];

/**
 * Следующий шаг: перезвон/повтор — по `next_call_at`; иначе ближайшая будущая запись; иначе открытая задача
 * (ближайшая по сроку); иначе «нет».
 */
export function pickNextStep(input: {
  state: string | null;
  nextCallAt: number | null;
  nextBookingAt: number | null;
  task: { source: string; dueAt: number | null } | null;
}): NextStep {
  if ((input.state === 'callback' || input.state === 'retry') && input.nextCallAt !== null) {
    return { kind: input.state as NextStepKind, at: input.nextCallAt };
  }
  if (input.nextBookingAt !== null) return { kind: 'booking', at: input.nextBookingAt };
  if (input.task) return { kind: 'task', at: input.task.dueAt, taskSource: input.task.source };
  return { kind: 'none', at: null };
}

export async function getClientSummary(viewer: Viewer, clientId: string, card: SummaryCard | null): Promise<ClientSummaryDto> {
  const db = await getDb();
  // Отдел передачи: покупки только сделки передачи и без сумм (D-300)
  const p = await selectSummaryParts(db.sql, viewer, clientId, seesDealsOnlyAsDepartment(viewer));
  return {
    period: p.period,
    calls: { total: card?.callsTotal ?? 0, connects: card?.connectsTotal ?? 0, noAnswer: card?.noAnswerTotal ?? 0 },
    lprFoundAt: p.lprFoundAt,
    bookings: p.bookings,
    purchases: p.purchases,
    handoffs: p.handoffs,
    ownerName: card?.ownerName ?? null,
    actingName: card?.actingName ?? null,
    nextStep: pickNextStep({ state: card?.state ?? null, nextCallAt: card?.nextCallAt ?? null, nextBookingAt: p.nextBookingAt, task: p.task }),
  };
}
