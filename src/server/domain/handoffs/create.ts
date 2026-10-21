// Передача в отдел при покупке и её отмена (B6, docs/deals-handoffs-design.md §5.6, D-250).
// Вызывается только из транзакции покупки или её отмены: карточка и сделка уже заблокированы и проверены.
import type { SystemActor, Viewer } from '@/server/access';
import { resolveLead } from '@/server/domain/cards';
import { newId } from '@/server/platform/db';
import {
  cancelOpenHandoff,
  cancelTasksByKeys,
  ensureHandoffTask,
  findHandoffIdOfDeal,
  findTeamForHandoff,
  insertHandoff,
  insertHandoffFeed,
  insertHandoffNotification,
  reopenCancelledHandoff,
} from './repo';
import { HANDOFF_TASK_KEYS, type CancelHandoffOfDeal, type CreateHandoffForDeal } from './types';

const actorIdOf = (a: Viewer | SystemActor): string | null => (a.kind === 'user' ? a.userId : null);

export const createHandoffForDeal: CreateHandoffForDeal = async (tx, actor, input) => {
  const team = await findTeamForHandoff(tx, { spaceId: input.spaceId, teamKey: input.teamKey });
  if (!team) {
    // Ошибка настроек: покупка проходит, передачу некому принять. В лог — только код, без ПДн
    console.warn('[handoffs] отдел для передачи не найден или в архиве');
    return null;
  }
  // Срок принятия — конец рабочего дня через acceptSlaWorkdays рабочих дней (чт 14:00 → пт 18:00)
  const due = input.settings.calendar.nthWorkdayAt(input.at, input.settings.acceptSlaWorkdays, input.settings.workHoursEnd);
  const created = await insertHandoff(tx, {
    id: newId(),
    spaceIdFrom: input.spaceId,
    spaceIdTo: team.spaceId,
    teamId: team.id,
    dealId: input.dealId,
    clientId: input.clientId,
    dueAt: due,
    at: input.at,
  });
  const reopened = created ? null : await reopenCancelledHandoff(tx, { dealId: input.dealId, teamId: team.id, spaceIdTo: team.spaceId, dueAt: due });
  const handoffId = created ?? reopened;
  if (!handoffId) {
    // Живая передача сделки уже есть (повтор эффекта): ничего не задваиваем
    const existing = await findHandoffIdOfDeal(tx, input.dealId);
    if (!existing) throw new Error('handoffs: передача не создана и строки сделки нет');
    return { handoffId: existing, created: false };
  }

  const me = actorIdOf(actor);
  const base = { spaceId: input.spaceId, clientId: input.clientId, dealId: input.dealId, teamId: team.id, dueAt: due, createdBy: me, at: input.at };
  if (team.leadActive && team.leadUserId) {
    await ensureHandoffTask(tx, { ...base, kind: 'handoff', assigneeUserId: team.leadUserId, sourceKey: HANDOFF_TASK_KEYS.accept(handoffId) });
    // Повторная передача той же сделки — новый колокол (ключ первого уже занят)
    const dedupeKey = created ? `handoff_new:${handoffId}` : `handoff_new:${handoffId}:${input.at}`;
    await insertHandoffNotification(tx, { userId: team.leadUserId, kind: 'handoff_new', handoffId, dedupeKey, at: input.at });
  } else {
    // Руководителя нет: РОП назначает руководителя, передача ждёт (D-250, вопрос владельцу §13)
    const lead = await resolveLead(tx, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, at: input.at });
    if (lead) await ensureHandoffTask(tx, { ...base, kind: 'check', assigneeUserId: lead, sourceKey: HANDOFF_TASK_KEYS.noLead(handoffId) });
    else console.warn('[handoffs] нет получателя задачи «Назначьте руководителя отдела»');
  }
  await insertHandoffFeed(tx, {
    clientId: input.clientId,
    spaceId: input.spaceId,
    dealId: input.dealId,
    handoffId,
    kind: 'handoff.created',
    actorId: me,
    at: input.at,
    data: { handoffId, teamKey: input.teamKey, serviceTypeKey: input.serviceTypeKey },
  });
  return { handoffId, created: true };
};

export const cancelHandoffOfDeal: CancelHandoffOfDeal = async (tx, _actor, input) => {
  const h = await cancelOpenHandoff(tx, input.dealId);
  if (!h) return false;
  // Отклонённая: задача РОП «отдел отказал» решена отменой покупки (D-301)
  const keys = [HANDOFF_TASK_KEYS.accept(h.id), HANDOFF_TASK_KEYS.noLead(h.id), HANDOFF_TASK_KEYS.work(h.id), HANDOFF_TASK_KEYS.declined(h.id)];
  await cancelTasksByKeys(tx, keys, input.at);
  // Отдел, который уже отказал, об отмене не уведомляем: передачи у него нет с момента отказа
  if (h.prevStatus === 'declined') return true;
  const to = [...new Set([h.leadUserId, h.assigneeUserId].filter((u): u is string => u !== null))];
  for (const userId of to) {
    await insertHandoffNotification(tx, { userId, kind: 'handoff_cancelled', handoffId: h.id, dedupeKey: `handoff_cancelled:${h.id}:${userId}:${input.at}`, at: input.at });
  }
  return true;
};
