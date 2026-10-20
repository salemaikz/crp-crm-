// Доступ: Viewer, обёртки route()/publicRoute()/page()/action(), ошибки и проверки прав (P4a).
// Здесь — то, что можно интерфейсу. Намеренно НЕ реэкспортируются:
// - scopeSql/scoped — только домен импортирует их из '@/server/access/scope';
// - systemActor() — только scripts/** и src/server/jobs/** из '@/server/access/systemActor'.
export type { Actor, LicenseState, ScopedEntity, SystemActor, Viewer } from './types';
export { SCOPED_ENTITIES } from './types';
export {
  AccessError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ReadOnlyError,
  UnauthorizedError,
  isAccessError,
  type AccessErrorCode,
} from './errors';
export { assertNotSelf, buildViewer, can, requireAccess, scopeOf, type BuildViewerOptions } from './viewer';
export {
  action,
  page,
  publicRoute,
  route,
  type ActionContext,
  type ActionOptions,
  type ActionResult,
  type AuditSpec,
  type GuardOptions,
  type NextRouteHandler,
  type PageContext,
  type PageOptions,
  type PublicRouteContext,
  type PublicRouteOptions,
  type Requirement,
  type RouteContext,
  type RouteOptions,
  type RouteParams,
} from './wrappers';
