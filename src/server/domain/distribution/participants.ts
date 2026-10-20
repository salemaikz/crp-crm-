// Участники раздачи: статус сегодня, нагрузка, остаток лимита, включение участия (docs/distribution-design.md §2, §5.1–5.2).
import { distribution as core } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { writeAudit } from '@/server/platform/audit';
import { getDb, type Sql } from '@/server/platform/db';
import { distributionDeps } from './deps';
import { requireRole, requireSpace } from './guards';
import { listParticipantRows, loadParticipantLoad, lockDistribution, updateInDistribution, updatePausedOn, type ParticipantRow } from './repo';
import type { DistributionConfig, ListParticipants, ParticipantView, SetParticipation, SetPause } from './types';

/** Статус на сегодня: отсутствие сильнее паузы; пауза действует только в день `paused_on` (PROCESS 7.5). */
export function participantStatus(row: Pick<ParticipantRow, 'pausedOn' | 'absentUntil'>, today: string): core.ParticipantStatus {
  if (row.absentUntil !== null) return 'absent';
  if (row.pausedOn === today) return 'paused';
  return 'working';
}

/** Участники пространства с нагрузкой и остатком лимита. `onlyInDistribution` — для тика. */
export async function loadParticipants(sql: Sql, cfg: DistributionConfig, now: number, opts: { onlyInDistribution?: boolean } = {}): Promise<ParticipantView[]> {
  const today = cfg.calendar.localDay(now);
  const rows = (await listParticipantRows(sql, { spaceId: cfg.spaceId, roles: cfg.participantRoles, today })).filter((r) => !opts.onlyInDistribution || r.inDistribution);
  const load = await loadParticipantLoad(sql, { spaceId: cfg.spaceId, userIds: rows.map((r) => r.userId), now, today });
  return rows.map((r) => {
    const l = load.get(r.userId) ?? { open: 0, openNew: 0, issuedToday: {} };
    return {
      userId: r.userId,
      name: r.name,
      status: participantStatus(r, today),
      open: l.open,
      openNew: l.openNew,
      issuedToday: l.issuedToday,
      inDistribution: r.inDistribution,
      capUsed: core.capUsed(l.issuedToday, cfg.settings.capIncludes),
      cap: cfg.settings.dailyCap,
      remaining: core.capRemaining({ issuedToday: l.issuedToday }, cfg.settings),
      absentUntil: r.absentUntil,
    };
  });
}

export const listParticipants: ListParticipants = async (viewer: Viewer) => {
  requireRole(viewer, 'pool.read');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const db = await getDb();
  return db.tx((tx) => loadParticipants(tx, cfg, now));
};

export const setParticipation: SetParticipation = async (viewer, input) => {
  requireRole(viewer, 'distribution.manage');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const db = await getDb();
  return db.tx(async (tx) => {
    const ok = await updateInDistribution(tx, { spaceId, userId: input.userId, roles: cfg.participantRoles, inDistribution: input.inDistribution, now });
    if (!ok) throw new NotFoundError();
    await writeAudit(tx, {
      actorId: viewer.userId,
      action: 'distribution.participant',
      entity: 'distribution',
      entityId: input.userId,
      spaceId,
      meta: { inDistribution: input.inDistribution },
      createdAt: now,
    });
    const view = (await loadParticipants(tx, cfg, now)).find((p) => p.userId === input.userId);
    if (!view) throw new NotFoundError();
    return view;
  });
};

/**
 * «Пауза» РОП на сегодня (PROCESS 7.5, D-256): `paused_on` = местный день или пусто. Снять — `paused: false`.
 * Тик и ручная выдача читают статус сами (C6a). Пауза отсутствующего разрешена (ничего не меняет).
 */
export const setPause: SetPause = async (viewer, input) => {
  requireRole(viewer, 'distribution.manage');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const db = await getDb();
  return db.tx(async (tx) => {
    await lockDistribution(tx);
    const ok = await updatePausedOn(tx, { spaceId, userId: input.userId, roles: cfg.participantRoles, value: input.paused ? cfg.calendar.localDay(now) : '', now });
    if (!ok) throw new NotFoundError();
    await writeAudit(tx, {
      actorId: viewer.userId,
      action: 'distribution.pause',
      entity: 'distribution',
      entityId: input.userId,
      spaceId,
      meta: { paused: input.paused },
      createdAt: now,
    });
    const view = (await loadParticipants(tx, cfg, now)).find((p) => p.userId === input.userId);
    if (!view) throw new NotFoundError();
    return view;
  });
};
