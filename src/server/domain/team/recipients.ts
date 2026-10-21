// Кому можно передавать дела (B9a, docs/tasks-team-design.md §6.4): роли из настроек, а не из кода.
// Получатель обычной передачи — активный сотрудник пространства, чья роль даёт `card.outcome`. Получатель
// «срочного» отключения — отключающий (если его роль ведёт карточки пространства целиком) или первый активный
// сотрудник роли `team.fallbackOwnerRole`.
import { access as coreAccess } from '@crm/core';
import type { Scope } from '@crm/core/access';
import { resolvers } from '@/server/access/context';
import { parseAccessConfig } from '@/server/access/viewer';
import { getActiveConfig } from '@/server/platform/config/active';
import type { Sql } from '@/server/platform/db';
import { badRequest } from './errors';
import { selectActiveMembers } from './transferRepo';

const { roleGrants } = coreAccess;

export interface TransferRoles {
  /** Охват `card.outcome` по ключу роли; роли без права в карте нет. */
  outcome: ReadonlyMap<string, Scope>;
  /** `team.fallbackOwnerRole`: роль, чей первый сотрудник принимает дела при «срочном» отключении. */
  fallbackOwnerRole: string | null;
}

export async function loadTransferRoles(): Promise<TransferRoles> {
  const doc = await resolvers().config();
  const cfg = parseAccessConfig(doc);
  const outcome = new Map<string, Scope>();
  for (const r of cfg.roles) {
    const scope = roleGrants(r).get('card.outcome');
    if (scope !== undefined) outcome.set(r.key, scope);
  }
  // Резервная роль — раздел `global.team` активных настроек (проверен схемой при записи ревизии)
  const fallback = (await getActiveConfig()).global.team.fallbackOwnerRole;
  return { outcome, fallbackOwnerRole: typeof fallback === 'string' && fallback !== '' ? fallback : null };
}

/** Проверка получателей обычной передачи: активны в пространстве, роль ведёт карточки. Иначе 400 `recipient`. */
export async function requireRecipients(tx: Sql, spaceId: string, userIds: readonly string[], roles: TransferRoles): Promise<void> {
  const unique = [...new Set(userIds)];
  const members = await selectActiveMembers(tx, { spaceId, userIds: unique });
  const ok = new Set(members.filter((m) => roles.outcome.has(m.roleKey)).map((m) => m.userId));
  if (unique.some((u) => !ok.has(u))) throw badRequest('recipient');
}

/**
 * Получатель дел отключённого в пространстве (§6.4 п. 1): отключающий, если его роль ведёт карточки всего
 * пространства; иначе первый активный сотрудник резервной роли. null — принять дела некому.
 */
export async function urgentRecipient(tx: Sql, a: { spaceId: string; actorId: string; exceptUserId: string; roles: TransferRoles }): Promise<string | null> {
  const [self] = await selectActiveMembers(tx, { spaceId: a.spaceId, userIds: [a.actorId] });
  const scope = self ? a.roles.outcome.get(self.roleKey) : undefined;
  if (self && (scope === 'space' || scope === 'all') && self.userId !== a.exceptUserId) return self.userId;
  if (a.roles.fallbackOwnerRole === null) return null;
  const members = await selectActiveMembers(tx, { spaceId: a.spaceId });
  return members.find((m) => m.roleKey === a.roles.fallbackOwnerRole && m.userId !== a.exceptUserId)?.userId ?? null;
}
