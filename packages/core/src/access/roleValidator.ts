// Валидатор ролей (ARCHITECTURE §5.1 п. 5, CONFIG §3.3): отклоняет пресет с опасными сочетаниями.
// Граница — по охвату, а не по имени роли: код не знает ключей ролей клиента.
import { PERMISSION_INFO, SCOPE_RANK, allowedForReadOnly, type Permission } from './catalog';
import { RELATIONS } from './relations';
import type { RoleConfig } from './roles';

export type RoleIssue = { path: (string | number)[]; code: RoleIssueCode; message: string };

export type RoleIssueCode =
  | 'duplicate_role'
  | 'duplicate_grant'
  | 'duplicate_relation'
  | 'duplicate_action'
  | 'scope_too_narrow'
  | 'own_with_pool_powers'
  | 'read_only_write'
  | 'relation_action_not_allowed';

/**
 * Разрешения, несовместимые с чтением карточек «только своё»: роль, которая видит только свои
 * карточки, не раздаёт, не видит пул и не передаёт клиентов (иначе она видит чужое через раздачу).
 */
export const OWN_INCOMPATIBLE: readonly Permission[] = ['distribution.manage', 'pool.read', 'card.assign', 'client.transfer'];

export function validateRoles(roles: readonly RoleConfig[]): RoleIssue[] {
  const issues: RoleIssue[] = [];
  const keys = new Set<string>();
  roles.forEach((role, ri) => {
    if (keys.has(role.key)) issues.push({ path: [ri, 'key'], code: 'duplicate_role', message: `роль ${role.key} повторяется` });
    keys.add(role.key);

    const perms = new Map<Permission, number>();
    role.grants.forEach((g, gi) => {
      const at = [ri, 'grants', gi];
      if (perms.has(g.perm)) issues.push({ path: at, code: 'duplicate_grant', message: `${g.perm} выдано дважды` });
      perms.set(g.perm, gi);
      if (PERMISSION_INFO[g.perm].minScope && SCOPE_RANK[g.scope] < SCOPE_RANK.space) {
        issues.push({ path: [...at, 'scope'], code: 'scope_too_narrow', message: `${g.perm} выдаётся только на пространство или все` });
      }
      if (role.readOnly && !allowedForReadOnly(g.perm)) {
        issues.push({ path: at, code: 'read_only_write', message: `роль «только чтение» не получает ${g.perm}` });
      }
    });

    const cardRead = role.grants.find((g) => g.perm === 'card.read');
    if (cardRead?.scope === 'own') {
      for (const p of OWN_INCOMPATIBLE) {
        const gi = perms.get(p);
        if (gi !== undefined) {
          issues.push({ path: [ri, 'grants', gi], code: 'own_with_pool_powers', message: `${p} несовместимо с card.read на «своё»` });
        }
      }
    }

    const rels = new Set<string>();
    role.relations.forEach((r, xi) => {
      const at = [ri, 'relations', xi];
      if (rels.has(r.key)) issues.push({ path: at, code: 'duplicate_relation', message: `отношение ${r.key} повторяется` });
      rels.add(r.key);
      const allowed = RELATIONS[r.key].actions;
      const seen = new Set<Permission>();
      r.actions.forEach((a, ai) => {
        if (seen.has(a)) issues.push({ path: [...at, 'actions', ai], code: 'duplicate_action', message: `${a} повторяется` });
        seen.add(a);
        if (!allowed.includes(a)) {
          issues.push({ path: [...at, 'actions', ai], code: 'relation_action_not_allowed', message: `${r.key} не даёт ${a}` });
        }
      });
      if (role.readOnly && r.actions.length > 0) {
        issues.push({ path: [...at, 'actions'], code: 'read_only_write', message: 'роль «только чтение» не получает действий отношения' });
      }
    });
  });
  return issues;
}
