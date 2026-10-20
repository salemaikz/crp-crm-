// Viewer: кто действует в запросе. Строится на каждом запросе: getSession() → users → активное
// членство → раздел ролей текущей ревизии настроек (getActiveConfig, парсится своей схемой Zod).
// Кэша прав нет: отключение, смена роли и передача клиента действуют со следующего запроса.
import { z } from 'zod';
import {
  RolesSchema,
  hasAccess,
  isValidTimeZone,
  localDay,
  roleGrants,
  roleRelations,
  type ActiveRelation,
  type Permission,
  type RoleConfig,
  type Scope,
} from '@crm/core/access';
import { getDb } from '@/server/platform/db';
import { resolvers } from './context';
import { ForbiddenError, NotFoundError, UnauthorizedError } from './errors';
import { registerActor } from './registry';
import { loadMemberships, loadUser } from './repo';
import type { LicenseState, Viewer } from './types';

export type BuildViewerOptions = {
  /** Пространство запроса; по умолчанию — пространство по умолчанию или первое с членством. */
  spaceId?: string;
};

/**
 * Часть документа настроек, нужная доступу. Ожидаемая форма — ConfigV1 (CONFIG §3.2):
 * `{ rev?, global: { org: { timezone }, roles: [...] }, spaces: {...} }`. Остальное здесь не
 * проверяется (passthrough) — это дело P5.
 */
const AccessConfigSchema = z
  .object({
    rev: z.number().int().nonnegative().optional(),
    global: z
      .object({
        org: z.object({ timezone: z.string().refine(isValidTimeZone, 'неизвестный пояс IANA') }).passthrough(),
        roles: RolesSchema,
      })
      .passthrough(),
  })
  .passthrough();

export type AccessConfig = { rev: number | null; timeZone: string; roles: readonly RoleConfig[] };

const parsed = new WeakMap<object, AccessConfig>();

/**
 * Раздел ролей и пояс из документа настроек. Ошибка схемы — исключение (fail closed: без ролей
 * никто ничего не видит, а не наоборот). Результат кэшируется по объекту документа.
 */
export function parseAccessConfig(doc: unknown): AccessConfig {
  if (typeof doc === 'object' && doc !== null) {
    const hit = parsed.get(doc);
    if (hit) return hit;
  }
  const r = AccessConfigSchema.safeParse(doc);
  if (!r.success) {
    const where = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`доступ: раздел ролей настроек не прошёл проверку — ${where.join('; ')}`);
  }
  const out: AccessConfig = Object.freeze({
    rev: r.data.rev ?? null,
    timeZone: r.data.global.org.timezone,
    roles: Object.freeze(r.data.global.roles),
  });
  if (typeof doc === 'object' && doc !== null) parsed.set(doc, out);
  return out;
}

const FROZEN = 'Viewer.grants только для чтения';

/** Map, который нельзя изменить после сборки Viewer. */
class FrozenMap<K, V> extends Map<K, V> {
  constructor(entries: Iterable<readonly [K, V]>) {
    super(); // super(entries) вызвал бы переопределённый set
    for (const [k, v] of entries) Map.prototype.set.call(this, k, v);
  }
  override set(): this {
    throw new Error(FROZEN);
  }
  override delete(): boolean {
    throw new Error(FROZEN);
  }
  override clear(): void {
    throw new Error(FROZEN);
  }
}

export type ViewerParts = {
  userId: string;
  isAdmin: boolean;
  spaceId: string | null;
  spaceIds: readonly string[];
  role: RoleConfig | null;
  teamId: string | null;
  license: LicenseState;
  configRev: number | null;
  now: number;
  timeZone: string;
};

/** Собрать и зарегистрировать Viewer из готовых частей (без БД). Архивная роль — как без роли. */
export function assembleViewer(p: ViewerParts): Viewer {
  const role = p.role && !p.role.archived ? p.role : null;
  const relations: ActiveRelation[] = role ? roleRelations(role).map((r) => Object.freeze(r)) : [];
  const viewer: Viewer = Object.freeze({
    kind: 'user' as const,
    userId: p.userId,
    isAdmin: p.isAdmin,
    spaceId: p.spaceId,
    spaceIds: Object.freeze([...p.spaceIds]),
    roleKey: role?.key ?? null,
    teamId: p.teamId,
    readOnly: role?.readOnly ?? false,
    grants: new FrozenMap(role ? roleGrants(role) : []),
    relations: Object.freeze(relations),
    license: p.license,
    configRev: p.configRev,
    now: p.now,
    today: localDay(p.now, p.timeZone),
    timeZone: p.timeZone,
  });
  return registerActor(viewer);
}

/** Собрать Viewer текущего запроса. Нет сессии или учётка отключена — UnauthorizedError. */
export async function buildViewer(opts: BuildViewerOptions = {}): Promise<Viewer> {
  const src = resolvers();
  const session = await src.session();
  if (!session) throw new UnauthorizedError();
  const db = await getDb();
  const user = await loadUser(db.sql, session.userId);
  if (!user || user.status !== 'active') throw new UnauthorizedError();
  const memberships = await loadMemberships(db.sql, user.id);
  const cfg = parseAccessConfig(await src.config());
  const license = await src.license();
  const current = opts.spaceId === undefined ? memberships[0] : memberships.find((m) => m.spaceId === opts.spaceId);
  // Пространство, в котором нет членства, для сотрудника не существует.
  if (opts.spaceId !== undefined && !current) throw new NotFoundError();
  const role = current ? (cfg.roles.find((r) => r.key === current.roleKey) ?? null) : null;
  return assembleViewer({
    userId: user.id,
    isAdmin: user.isAdmin,
    spaceId: current?.spaceId ?? null,
    spaceIds: memberships.map((m) => m.spaceId),
    role,
    teamId: current?.teamId ?? null,
    license,
    configRev: cfg.rev,
    now: src.now(),
    timeZone: cfg.timeZone,
  });
}

/** Охват роли по разрешению (без отношений); null — не выдано. */
export function scopeOf(viewer: Viewer, perm: Permission): Scope | null {
  return viewer.grants.get(perm) ?? null;
}

/** Есть ли у сотрудника разрешение хоть в каком-то охвате или через отношение. */
export function can(viewer: Viewer, perm: Permission): boolean {
  return hasAccess(viewer.grants, viewer.relations, perm);
}

/** Нет разрешения → NotFoundError для объекта, ForbiddenError для раздела. */
export function requireAccess(viewer: Viewer, perm: Permission, target: 'object' | 'section'): void {
  if (can(viewer, perm)) return;
  throw target === 'object' ? new NotFoundError() : new ForbiddenError();
}

/** Назначить роль самому себе нельзя (§5.1 п. 4): ForbiddenError. */
export function assertNotSelf(viewer: Viewer, targetUserId: string): void {
  if (viewer.userId === targetUserId) throw new ForbiddenError();
}
