// Сервис «Сотрудники» (R2a): список, приглашение, повторная отправка/отзыв, сброс пароля, смена роли и
// признака администратора, отключение. Вызывается только из обёрток route()/page() с правом 'admin'.
// Все изменения — в одной транзакции вместе с аудитом; в аудит идут id и коды, без имён и номеров.
import { assertNotSelf } from '@/server/access/viewer';
import type { Viewer } from '@/server/access/types';
import { NotFoundError } from '@/server/access/errors';
import { revokeAllSessions, issueInvite, issuePasswordReset, revokePendingInvites, readSecurityPolicy, maskPhone, loginPhoneDigits } from '@/server/platform/auth';
import { writeAudit } from '@/server/platform/audit';
import { getDb, type Sql } from '@/server/platform/db';
import { badRequest, conflict } from './errors';
import { staffHandover, type HandoverResult, type StaffHandover } from './handover';
import * as repo from './repo';
import { requireBulkFeature } from './transfer';
import { assignableRoles } from './roles';
import type { DisableInput, InviteInput, ResendInput, UpdateInput } from './schemas';
import type { IssuedLink, StaffList, StaffRow } from './types';

type Clock = { now?: () => number };

const nowOf = (viewer: Viewer, deps?: Clock) => deps?.now?.() ?? viewer.now;

function toRow(r: repo.StaffRecord, selfId: string, spaceKnown: boolean): StaffRow {
  const status = r.status === 'disabled' ? 'disabled' : r.hasPassword ? 'active' : 'invited';
  return {
    id: r.id,
    name: r.name,
    phoneMasked: maskPhone(r.phoneDigits),
    status,
    isAdmin: r.isAdmin,
    roleKey: spaceKnown ? (r.memberRole ?? (status === 'invited' ? r.inviteRole || null : null)) : null,
    inviteState: status === 'invited' ? (r.inviteLive ? 'live' : 'inactive') : null,
    lastLoginAt: r.lastLoginAt,
    isSelf: r.id === selfId,
  };
}

/** Пространство запроса: своё у администратора с ролью, иначе по умолчанию. */
async function spaceOf(sql: Sql, viewer: Viewer): Promise<string | null> {
  return viewer.spaceId ?? (await repo.defaultSpaceId(sql));
}

export async function listStaff(viewer: Viewer, deps?: Clock): Promise<StaffList> {
  const db = await getDb();
  const spaceId = await spaceOf(db.sql, viewer);
  const rows = await repo.listStaff(db.sql, spaceId, nowOf(viewer, deps));
  return { staff: rows.map((r) => toRow(r, viewer.userId, spaceId !== null)), roles: await assignableRoles() };
}

async function requireAssignable(roleKey: string): Promise<void> {
  const roles = await assignableRoles();
  if (!roles.some((r) => r.key === roleKey)) throw badRequest('unknown_role');
}

function link(userId: string, invite: { link: string; expiresAt: number }, ttlHours: number): IssuedLink {
  return { userId, link: invite.link, expiresAt: invite.expiresAt, ttlHours };
}

/** Приглашение нового сотрудника. Ссылка возвращается один раз и нигде не хранится. */
export async function inviteStaff(viewer: Viewer, input: InviteInput, deps?: Clock): Promise<IssuedLink> {
  const phoneDigits = loginPhoneDigits(input.phone);
  if (!phoneDigits) throw badRequest('phone');
  if (input.roleKey) await requireAssignable(input.roleKey);
  const policy = await readSecurityPolicy();
  const db = await getDb();
  const spaceId = input.roleKey ? await spaceOf(db.sql, viewer) : null;
  if (input.roleKey && !spaceId) throw badRequest('no_space');
  const res = await db.tx((sql) =>
    issueInvite(sql, {
      phoneDigits,
      name: input.name,
      spaceId,
      roleKey: input.roleKey ?? '',
      teamId: null,
      isAdmin: input.isAdmin === true,
      createdBy: viewer.userId,
      policy,
      nowMs: nowOf(viewer, deps),
    }),
  );
  if (!res.ok) throw res.error === 'self_role' ? badRequest('self_role') : conflict(res.error);
  return link(res.invite.userId, res.invite, policy.inviteTtlHours);
}

/** Новая ссылка тому, кто ещё не принял приглашение; прежняя перестаёт действовать. Роль можно сменить. */
export async function resendInvite(viewer: Viewer, userId: string, input: ResendInput = {}, deps?: Clock): Promise<IssuedLink> {
  assertNotSelf(viewer, userId);
  if (input.roleKey) await requireAssignable(input.roleKey);
  const policy = await readSecurityPolicy();
  const db = await getDb();
  const res = await db.tx(async (sql) => {
    const user = await repo.lockUser(sql, userId);
    if (!user) throw new NotFoundError();
    if (user.status === 'disabled') throw conflict('disabled');
    if (user.hasPassword) throw conflict('already_active');
    const prev = await repo.lastInvite(sql, user.phoneDigits);
    const roleKey = input.roleKey ?? prev?.roleKey ?? '';
    const spaceId = roleKey === '' ? null : (prev?.spaceId ?? (await spaceOf(sql, viewer)));
    if (roleKey !== '') {
      if (!spaceId) throw badRequest('no_space');
      await requireAssignable(roleKey);
    }
    return issueInvite(sql, {
      phoneDigits: user.phoneDigits,
      name: user.name,
      spaceId,
      roleKey,
      teamId: prev?.teamId ?? null,
      createdBy: viewer.userId,
      policy,
      nowMs: nowOf(viewer, deps),
    });
  });
  if (!res.ok) throw conflict(res.error);
  return link(userId, res.invite, policy.inviteTtlHours);
}

/** Отозвать неиспользованные ссылки. Сотрудник остаётся в списке «приглашён, ссылка не действует». */
export async function revokeInvite(viewer: Viewer, userId: string, deps?: Clock): Promise<{ revoked: number }> {
  assertNotSelf(viewer, userId);
  const db = await getDb();
  const nowMs = nowOf(viewer, deps);
  return db.tx(async (sql) => {
    const user = await repo.lockUser(sql, userId);
    if (!user) throw new NotFoundError();
    if (user.hasPassword) throw conflict('already_active');
    const revoked = await revokePendingInvites(sql, user.phoneDigits, nowMs);
    await writeAudit(sql, {
      actorId: viewer.userId,
      action: 'user.invite_revoke',
      entity: 'user',
      entityId: user.id,
      meta: { revoked },
      createdAt: nowMs,
    });
    return { revoked };
  });
}

/** Ссылка сброса пароля для сотрудника с паролем. Сессии закроются, когда он её примет. */
export async function resetPassword(viewer: Viewer, userId: string, deps?: Clock): Promise<IssuedLink> {
  assertNotSelf(viewer, userId);
  const policy = await readSecurityPolicy();
  const db = await getDb();
  const res = await db.tx(async (sql) => {
    const user = await repo.lockUser(sql, userId);
    if (!user) throw new NotFoundError();
    if (user.status === 'disabled') throw conflict('disabled');
    if (!user.hasPassword) throw conflict('not_activated');
    return issuePasswordReset(sql, { userId, createdBy: viewer.userId, policy, nowMs: nowOf(viewer, deps) });
  });
  if (!res.ok) throw res.error === 'not_found' ? new NotFoundError() : conflict(res.error);
  return link(userId, res.invite, policy.inviteTtlHours);
}

/** Смена роли и/или признака администратора. Над собой — нельзя (§5.1 п. 4). Действует со следующего запроса. */
export async function updateStaff(viewer: Viewer, userId: string, input: UpdateInput, deps?: Clock): Promise<{ changed: string[] }> {
  assertNotSelf(viewer, userId);
  if (input.roleKey) await requireAssignable(input.roleKey);
  const db = await getDb();
  const nowMs = nowOf(viewer, deps);
  return db.tx(async (sql) => {
    const user = await repo.lockUser(sql, userId);
    if (!user) throw new NotFoundError();
    if (user.status === 'disabled') throw conflict('disabled');
    const changed: string[] = [];
    if (input.roleKey) {
      // приглашённому роль меняется повторной отправкой ссылки: членства у него ещё нет
      if (!user.hasPassword) throw conflict('not_activated');
      const spaceId = await spaceOf(sql, viewer);
      if (!spaceId) throw badRequest('no_space');
      const prev = await repo.memberRole(sql, userId, spaceId);
      if (prev?.roleKey !== input.roleKey) {
        await repo.upsertRole(sql, userId, spaceId, input.roleKey, nowMs);
        await writeAudit(sql, {
          actorId: viewer.userId,
          action: 'user.role_change',
          entity: 'user',
          entityId: userId,
          spaceId,
          meta: { from: prev?.roleKey ?? null, to: input.roleKey },
          createdAt: nowMs,
        });
        changed.push('role');
      }
    }
    if (input.isAdmin !== undefined && input.isAdmin !== user.isAdmin) {
      await repo.setAdmin(sql, userId, input.isAdmin);
      await writeAudit(sql, {
        actorId: viewer.userId,
        action: 'user.admin_change',
        entity: 'user',
        entityId: userId,
        meta: { isAdmin: input.isAdmin },
        createdAt: nowMs,
      });
      changed.push('admin');
    }
    return { changed };
  });
}

export type DisableDeps = Clock & { handover?: StaffHandover };
export type DisableResult = { alreadyDisabled: boolean; sessionsRevoked: number; invitesRevoked: number; handover: HandoverResult };

/**
 * Отключение: вход закрыт сразу (учётка и членства, сессии, неиспользованные ссылки), затем передача дел.
 * Повтор безопасен. Передача дел — handover.ts (B9a, D-066, D-255): «срочно» всегда, мастер с получателем — за флагом.
 */
export async function disableStaff(viewer: Viewer, userId: string, input: DisableInput = { mode: 'urgent' }, deps?: DisableDeps): Promise<DisableResult> {
  assertNotSelf(viewer, userId);
  const handover = deps?.handover ?? staffHandover;
  if (input.to !== undefined) requireBulkFeature();
  const db = await getDb();
  const nowMs = nowOf(viewer, deps);
  return db.tx(async (sql) => {
    const user = await repo.lockUser(sql, userId);
    if (!user) throw new NotFoundError();
    if (user.status === 'disabled') {
      return { alreadyDisabled: true, sessionsRevoked: 0, invitesRevoked: 0, handover: { status: 'done', movedCards: 0, releasedCards: 0, actingCards: 0, spaces: [] } } satisfies DisableResult;
    }
    await repo.disableUser(sql, userId, nowMs);
    const sessionsRevoked = await revokeAllSessions(sql, userId);
    const invitesRevoked = await revokePendingInvites(sql, user.phoneDigits, nowMs);
    const result = await handover.run(sql, {
      actorId: viewer.userId,
      viewer,
      userId,
      spaceId: await spaceOf(sql, viewer),
      mode: input.mode,
      to: input.to,
      nowMs,
    });
    await writeAudit(sql, {
      actorId: viewer.userId,
      action: 'user.disable',
      entity: 'user',
      entityId: userId,
      meta: { mode: input.mode, sessionsRevoked, invitesRevoked, handover: result.status, movedCards: result.movedCards, releasedCards: result.releasedCards, actingCards: result.actingCards },
      createdAt: nowMs,
    });
    return { alreadyDisabled: false, sessionsRevoked, invitesRevoked, handover: result };
  });
}
