// Очередь «Звонить» (docs/calls-design.md §8, D-177): свои карточки (владелец или временный владелец) в порядке
// групп `queue.order`, пропущенные сегодня — в конце. Только данные своих карточек; номера — рабочие и не из стоп-листа.
import { calling, fields } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { fieldViewer, loadClientsConfig, type ClientsConfig } from '@/server/domain/clients';
import { ConfigMissingError } from '@/server/platform/config/active';
import { getDb } from '@/server/platform/db';
import { countQueue, countSkipsToday, groupOfState, queueClients, queueLastNotes, queueLprs, queuePhones, selectQueue } from './repo';
import type { GetQueue, QueueCard, QueueCounts } from './types';

/** Настройки полей; нет ревизии настроек — полей в ответе нет (fail closed, не 500 на очереди). */
async function fieldsConfigOrNull(viewer: Viewer): Promise<ClientsConfig | null> {
  try {
    return await loadClientsConfig(viewer);
  } catch (e) {
    if (e instanceof ConfigMissingError) return null;
    throw e;
  }
}

export const getQueue: GetQueue = async (deps, viewer, q) => {
  const spaceId = viewer.spaceId;
  if (spaceId === null) throw new NotFoundError();
  const now = deps.now();
  const ctx = await deps.context(spaceId, now);
  const today = ctx.calendar.localDay(now);
  const db = await getDb();
  const sql = db.sql;

  const rows = await selectQueue(sql, viewer, {
    spaceId,
    userId: viewer.userId,
    now,
    today,
    order: ctx.queue.order,
    mobileFirst: ctx.queue.mobileFirst,
    group: q.group,
    exclude: q.exclude,
    limit: q.limit,
  });
  const c = await countQueue(sql, viewer, { spaceId, userId: viewer.userId, now, bounds: calling.dueBounds(now, ctx.overdueAlertMinutes, ctx.calendar) });
  const skippedToday = await countSkipsToday(sql, viewer.userId, today);
  const counts: QueueCounts = {
    dueNow: c.callbacks + c.retries + c.new,
    overdue: c.overdue,
    callbacks: c.callbacks,
    retries: c.retries,
    returns: 0,
    new: c.new,
    skippedToday,
    skipLimit: ctx.queue.skipLimit,
  };

  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const [clients, phones, cfg, lprs, notes] = await Promise.all([
    queueClients(sql, clientIds),
    queuePhones(sql, clientIds),
    fieldsConfigOrNull(viewer),
    queueLprs(sql, clientIds),
    queueLastNotes(sql, spaceId, clientIds),
  ]);
  const clientById = new Map(clients.map((x) => [x.id, x]));
  const lprByClient = new Map(lprs.map((x) => [x.clientId, x]));
  const noteByClient = new Map(notes.map((x) => [x.clientId, x]));
  const fv = cfg ? fieldViewer(viewer, cfg) : null;

  const items: QueueCard[] = rows.map((r) => {
    const client = clientById.get(r.clientId);
    const values: Record<string, unknown> = {};
    if (cfg && fv) {
      Object.assign(values, fields.projectFor(fv, 'client', cfg.fields, (client?.custom ?? {}) as fields.CustomValues).values);
      Object.assign(values, fields.projectFor(fv, 'card', cfg.fields, (r.custom ?? {}) as fields.CustomValues).values);
    }
    const lpr = lprByClient.get(r.clientId);
    const note = noteByClient.get(r.clientId);
    const lprPhone = lpr ? phones.find((p) => p.contactId === lpr.id) : undefined;
    return {
      cardId: r.id,
      clientId: r.clientId,
      version: r.version,
      state: r.state,
      group: groupOfState(r.state),
      skippedToday: r.skippedAt !== null,
      name: client?.name ?? '',
      attempts: r.attempts,
      lastOutcomeCode: r.lastOutcomeCode,
      lastOutcomeAt: r.lastOutcomeAt,
      nextCallAt: r.nextCallAt,
      lpr: r.lpr,
      isTarget: r.isTarget,
      phones: phones.filter((p) => p.clientId === r.clientId).map((p) => ({ id: p.id, digits: p.digits, kind: p.kind, isPrimary: p.isPrimary })),
      decisionMaker: lpr ? { contactId: lpr.id, name: lpr.name, position: lpr.position, phone: lprPhone?.digits ?? null } : null,
      lastNote: note ? { text: note.text, at: Number(note.at) } : null,
      fields: values,
    };
  });
  return { counts, items };
};
