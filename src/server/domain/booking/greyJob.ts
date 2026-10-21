// Автоназначение «серых» заявок на консультацию (B5b, docs/deals-handoffs-design.md §4.8, D-247).
// Прогон — одна транзакция на сегодняшнюю дату пространства под блокировкой дня: снимок → `planGreyProposals`.
// `assign` назначает по предложениям, `suggest` только зовёт РОП колоколом, не подобранным — задача РОП.
// Будущие даты не трогаем: их «серые» назначатся в 09:00 своего дня (PROCESS 5.2). Идемпотентность — по состоянию:
// назначается только заявка без консультанта, колокол и задача держатся своими ключами.
import { booking as core } from '@crm/core';
import { closeAutoTaskByKey } from '@/server/domain/tasks/auto';
import { newId } from '@/server/platform/db';
import { loadDay, lockConsultDay } from './consultDay';
import type { RunGreyAssign } from './consultTypes';
import { loadBookingOpsSettings } from './opsSettings';
import { ensureGreyTask, greyTaskKey, notifyConsultantAssigned, notifyConsultNew, notifyGreySuggest } from './reserve';
import { insertFeed, insertHistory } from './repo';
import { assignGreyRow, listGreyDetails } from './repo.consult';
import { inBookingTx } from './tx';

export const runGreyAssign: RunGreyAssign = async (deps, actor, input) => {
  const { spaceId, now } = input;
  const [settings, ops] = await Promise.all([deps.settings(spaceId, now), loadBookingOpsSettings(spaceId, now)]);
  const date = core.epochToLocalDate(settings.timeZone, now);
  const report = { date, mode: ops.grey.mode, assigned: 0, suggested: 0, unassignable: 0 };

  await inBookingTx({}, async (tx) => {
    await lockConsultDay(tx, spaceId, date);
    const { snapshot } = await loadDay(tx, spaceId, date, settings);
    const details = new Map((await listGreyDetails(tx, core.greyBookings(snapshot).map((b) => b.id))).map((d) => [d.id, d]));
    // Заявки, время которых уже прошло, не назначаем: консультация состоялась или сорвалась
    const upcoming = core.greyBookings(snapshot).filter((b) => (details.get(b.id)?.startsAt ?? 0) > now);
    const pending = core.pendingGreys(upcoming, null, new Set(), ops.grey.mode);
    const plan = core.planGreyProposals(snapshot, pending);

    for (const p of plan.proposals) {
      const d = details.get(p.booking.id);
      if (!d) continue;
      if (ops.grey.mode === 'suggest') {
        if (await notifyGreySuggest(tx, { bookingId: d.id, spaceId, ownerUserId: d.responsibleUserId, at: now })) report.suggested++;
        continue;
      }
      const consultant = snapshot.consultants.find((c) => c.id === p.consultantId);
      if (!consultant) continue;
      const durationMin = consultant.usesSchedule ? consultant.slotMin : p.booking.durationMin;
      const row = await assignGreyRow(tx, { id: d.id, resourceId: consultant.id, durationMin, at: now });
      // Заявку уже назначил человек или отменили: автоназначение молчит
      if (!row) continue;
      await insertHistory(tx, {
        id: newId(),
        bookingId: d.id,
        action: 'assigned',
        from: d.status,
        to: d.status,
        actorId: null,
        meta: { resourceId: consultant.id, from: '', auto: true },
        at: now,
      });
      await insertFeed(tx, { clientId: d.clientId, spaceId, dealId: d.dealId, kind: 'booking.assigned', actorId: null, bookingId: d.id, at: now, data: { bookingId: d.id, resourceId: consultant.id } });
      await closeAutoTaskByKey(tx, actor, { sourceKey: greyTaskKey(d.id), at: now });
      await notifyConsultNew(tx, { bookingId: d.id, resourceId: consultant.id, exceptUserId: null, at: now });
      await notifyConsultantAssigned(tx, { bookingId: d.id, resourceId: consultant.id, authorUserId: d.bookedByUserId, exceptUserId: null, at: now });
      report.assigned++;
    }

    for (const g of plan.unassignable) {
      const d = details.get(g.id);
      if (!d) continue;
      await ensureGreyTask(tx, actor, { bookingId: d.id, spaceId, clientId: d.clientId, dealId: d.dealId, startsAt: d.startsAt, ownerUserId: d.responsibleUserId, at: now });
      report.unassignable++;
    }
  });
  return report;
};
