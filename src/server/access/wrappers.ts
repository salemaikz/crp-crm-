// Обёртки route(), publicRoute(), page(), action() (ARCHITECTURE §5.2 п. 1–3, D-017).
// Каждый route handler, server action и страница с данными обёрнуты и описаны в манифесте изоляции.
// Обёртка: сессия → Viewer (перечитывается из БД) → блокировка мутаций (роль «только чтение»,
// лицензия) → разрешение → обработчик → аудит. Ошибки доступа — единые ответы (errors.ts).
import type { Permission, SecurityMutation } from '@crm/core/access';
import type { AuditAction, AuditEntity } from '@/server/platform/audit';
import type { AccessErrorCode } from './errors';
import type { Viewer } from './types';

/** Что нужно для входа: разрешение каталога, просто вход или признак администратора. */
export type Requirement = Permission | 'authenticated' | 'admin';

/**
 * Аудит чувствительного действия после успешного обработчика (§5.2 п. 9). Имя действия — из
 * реестра AUDIT_ACTIONS платформы; модуль добавляет свои строки туда.
 */
export type AuditSpec<C, R> = {
  action: AuditAction;
  entity: AuditEntity;
  /** id объекта для журнала; null — действие без объекта (пишется id сотрудника). */
  entityId: (ctx: C, result: R) => string | null;
  /** Коды и числа без ПДн. */
  meta?: (ctx: C, result: R) => Record<string, unknown>;
};

export type GuardOptions = {
  perm: Requirement;
  /**
   * Чего касается запрос: `object` — конкретного объекта (нет права → 404, как у несуществующего),
   * `section` — раздела (нет права → 403). По умолчанию `section`.
   */
  target?: 'object' | 'section';
  /** Мутация безопасности из закрытого списка D-054: не блокируется ни «только чтением», ни лицензией. */
  securityMutation?: SecurityMutation;
};

export type RouteParams = Record<string, string | string[] | undefined>;
export type RouteContext = { req: Request; params: RouteParams; viewer: Viewer };
export type PublicRouteContext = { req: Request; params: RouteParams };

export type RouteOptions = GuardOptions & { audit?: AuditSpec<RouteContext, unknown> };

export type PublicRouteOptions = {
  /** Зачем маршрут открыт без сессии: вход, приглашение, приём по ключу, вебхук, healthcheck. */
  reason: 'auth' | 'invite' | 'ingest' | 'webhook' | 'health';
  /**
   * Проверка Origin у мутирующих методов. `skip` — только машинные входы с ключом или подписью
   * (приём, вебхуки); вход и приглашение проверяют Origin.
   */
  origin: 'check' | 'skip';
};

/** Сигнатура route handler Next 16: второй аргумент — `{ params: Promise<…> }`. */
export type NextRouteHandler = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;

/**
 * Обработчик может вернуть Response или данные (уйдут JSON). Ответы API не кэшируются (D-033):
 * обёртка ставит `Cache-Control: no-store`.
 */
export function route(opts: RouteOptions, handler: (ctx: RouteContext) => Promise<unknown>): NextRouteHandler {
  void opts;
  void handler;
  throw new Error('route: P4a, этап 2');
}

/** Маршрут без сессии. Описывается в манифесте изоляции так же, как остальные. */
export function publicRoute(opts: PublicRouteOptions, handler: (ctx: PublicRouteContext) => Promise<unknown>): NextRouteHandler {
  void opts;
  void handler;
  throw new Error('publicRoute: P4a, этап 2');
}

export type PageOptions = GuardOptions;
export type PageContext<P> = { viewer: Viewer; props: P };

/**
 * Страница или layout с данными. Нет сессии — переход на вход; нет права или объекта — notFound()
 * (404 и для раздела: forbidden() в Next 16 экспериментален, а 404 не выдаёт больше, чем 403).
 */
export function page<P, R>(opts: PageOptions, loader: (ctx: PageContext<P>) => Promise<R>): (props: P) => Promise<R> {
  void opts;
  void loader;
  throw new Error('page: P4a, этап 2');
}

/** Итог server action: данные или код ошибки (без текста). */
export type ActionResult<R> = { ok: true; data: R } | { ok: false; error: AccessErrorCode | 'internal'; detail?: string };

export type ActionContext = { viewer: Viewer };

export type ActionOptions<A extends unknown[], R> = GuardOptions & {
  /** Только чтение (server action, которая ничего не меняет). По умолчанию action — мутация. */
  readOnlyAction?: boolean;
  audit?: AuditSpec<{ viewer: Viewer; args: A }, R>;
};

/** Server action. Origin для server actions проверяет сам Next (сравнение с Host). */
export function action<A extends unknown[], R>(
  opts: ActionOptions<A, R>,
  fn: (ctx: ActionContext, ...args: A) => Promise<R>,
): (...args: A) => Promise<ActionResult<R>> {
  void opts;
  void fn;
  throw new Error('action: P4a, этап 2');
}
