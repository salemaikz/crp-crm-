// Обёртки route(), publicRoute(), page(), action() (ARCHITECTURE §5.2 п. 1–3, D-017, D-074).
// Каждый route handler, server action и страница с данными обёрнуты и описаны в манифесте изоляции.
// Порядок: Origin (мутирующий метод и любой server action) → сессия (продление срока перевыпускает
// cookie, D-154) → Viewer (перечитывается из БД) → блокировка мутаций (роль «только чтение»,
// лицензия; кроме D-054) → разрешение → обработчик → аудит. Ошибки доступа — единые ответы без текста.
import { notFound, redirect } from 'next/navigation';
import { access as coreAccess } from '@crm/core';
import type { Permission, SecurityMutation } from '@crm/core/access';
import { writeAudit, type AuditAction, type AuditEntity } from '@/server/platform/audit';
import { checkOrigin as checkOriginHeaders } from '@/server/platform/auth/csrf';
import { getDb } from '@/server/platform/db';
import { AccessError, ForbiddenError, HTTP_STATUS, NotFoundError, ReadOnlyError, UnauthorizedError, errorBody, type AccessErrorCode } from './errors';
import { resolveViewer } from './current';
import { requireAccess } from './viewer';
import { LOCKING_LICENSE_STATES, type Viewer } from './types';

const { PERMISSION_INFO } = coreAccess;

/** Что нужно для входа: разрешение каталога, просто вход или признак администратора. */
export type Requirement = Permission | 'authenticated' | 'admin';

/** Путь страницы входа (P3 может перенести; тогда меняется здесь). */
export const LOGIN_PATH = '/login';

/**
 * Аудит чувствительного действия после успешного обработчика (§5.2 п. 9). Имя действия — из
 * реестра AUDIT_ACTIONS платформы; модуль добавляет свои строки туда. Действия, которые должны
 * попасть в журнал атомарно с изменением (слияние, передача), пишут аудит в своей транзакции.
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Меняет ли данные запрос с таким требованием. Мутирующий метод с разрешением чтения или выгрузки
 * (поиск POST-ом, выгрузка) мутацией не считается: «только чтение» и лицензия его не блокируют.
 * 'authenticated' и 'admin' на мутирующем методе — мутация (осторожно по умолчанию).
 */
export function isMutation(perm: Requirement, mutatingMethod: boolean): boolean {
  if (!mutatingMethod) return false;
  if (perm === 'authenticated' || perm === 'admin') return true;
  return PERMISSION_INFO[perm].kind === 'write';
}

/** Сессия есть: блокировка мутаций, затем разрешение. Бросает ошибки доступа. */
export function checkGuard(viewer: Viewer, opts: GuardOptions, mutation: boolean): void {
  const locked = viewer.readOnly || LOCKING_LICENSE_STATES.has(viewer.license);
  if (mutation && locked && !opts.securityMutation) throw new ReadOnlyError();
  const target = opts.target ?? 'section';
  if (opts.perm === 'authenticated') return;
  if (opts.perm === 'admin') {
    if (!viewer.isAdmin) throw target === 'object' ? new NotFoundError() : new ForbiddenError();
    return;
  }
  requireAccess(viewer, opts.perm, target);
}

/**
 * CSRF поверх SameSite=Lax (второй рубеж D-095, D-153): та же проверка, что в src/proxy.ts — auth/csrf.ts
 * (Origin = нормализованный APP_ORIGIN, Sec-Fetch-Site; в production без APP_ORIGIN — отказ).
 * Origin из req.url — только вне production и без APP_ORIGIN (разработка, тесты без заголовка Host).
 */
export function checkOrigin(req: Request): void {
  let requestOrigin: string | undefined;
  try {
    requestOrigin = new URL(req.url).origin;
  } catch {
    requestOrigin = undefined;
  }
  if (checkOriginHeaders(req.headers, process.env, { requestOrigin }) !== 'ok') throw new ForbiddenError();
}

/**
 * Origin server action. Next сам сверяет Origin с Host, но пропускает запрос вообще без Origin —
 * поэтому проверка обязательна здесь. Нет области запроса (вызов вне Next) — отказ (fail closed).
 */
async function checkActionOrigin(): Promise<void> {
  let h: Headers;
  try {
    const { headers } = await import('next/headers');
    h = await headers();
  } catch {
    throw new ForbiddenError();
  }
  if (checkOriginHeaders(h, process.env) !== 'ok') throw new ForbiddenError();
}

/** Управляющие исключения Next (notFound, redirect и т. п.) пробрасываются как есть. */
function isNextControl(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === 'string' && (d.startsWith('NEXT_') || d === 'DYNAMIC_SERVER_USAGE');
}

function errorCode(e: unknown): { code: AccessErrorCode | 'internal'; detail?: string } {
  if (e instanceof AccessError) {
    const detail = (e as { detail?: unknown }).detail;
    return typeof detail === 'string' ? { code: e.code, detail } : { code: e.code };
  }
  if ((e as { name?: unknown } | null)?.name === 'ZodError') return { code: 'bad_request', detail: 'invalid' };
  // В лог — только имя, код и сообщение: detail ошибок Postgres содержит значения строк (ПДн).
  const err = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  console.error('[access] необработанная ошибка', err?.name, err?.code ?? '', err?.message ?? '');
  return { code: 'internal' };
}

const NO_STORE = 'no-store';

function jsonError(code: AccessErrorCode | 'internal', detail?: string): Response {
  return Response.json(errorBody(code, detail), { status: HTTP_STATUS[code], headers: { 'Cache-Control': NO_STORE } });
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) {
    try {
      if (!result.headers.has('Cache-Control')) result.headers.set('Cache-Control', NO_STORE);
    } catch {
      // заголовки неизменяемы (ответ из fetch) — оставляем как есть
    }
    return result;
  }
  if (result === undefined) return new Response(null, { status: 204, headers: { 'Cache-Control': NO_STORE } });
  return Response.json(result, { headers: { 'Cache-Control': NO_STORE } });
}

async function readParams(ctx: { params: Promise<unknown> } | undefined): Promise<RouteParams> {
  const p = ctx ? await ctx.params : undefined;
  return p && typeof p === 'object' ? (p as RouteParams) : {};
}

async function audit<C, R>(viewer: Viewer, spec: AuditSpec<C, R>, ctx: C, result: R): Promise<void> {
  const db = await getDb();
  await writeAudit(db.sql, {
    actorId: viewer.userId,
    action: spec.action,
    entity: spec.entity,
    entityId: spec.entityId(ctx, result) ?? viewer.userId,
    spaceId: viewer.spaceId,
    meta: spec.meta?.(ctx, result) ?? {},
  });
}

/**
 * Route handler с сессией. Обработчик может вернуть Response или данные (уйдут JSON; undefined —
 * 204). Ответы API не кэшируются (D-033): обёртка ставит `Cache-Control: no-store`.
 */
export function route(opts: RouteOptions, handler: (ctx: RouteContext) => Promise<unknown>): NextRouteHandler {
  return async (req, ctx) => {
    try {
      const mutating = !SAFE_METHODS.has(req.method.toUpperCase());
      if (mutating) checkOrigin(req);
      const viewer = await resolveViewer();
      checkGuard(viewer, opts, isMutation(opts.perm, mutating));
      const c: RouteContext = { req, params: await readParams(ctx), viewer };
      const result = await handler(c);
      if (opts.audit) await audit(viewer, opts.audit, c, result);
      return toResponse(result);
    } catch (e) {
      if (isNextControl(e)) throw e;
      const { code, detail } = errorCode(e);
      return jsonError(code, detail);
    }
  };
}

/**
 * Маршрут без сессии (вход, приглашение, приём по ключу, вебхук, healthcheck). Описывается в
 * манифесте изоляции так же, как остальные; лицензию и ключи проверяет сам обработчик.
 */
export function publicRoute(opts: PublicRouteOptions, handler: (ctx: PublicRouteContext) => Promise<unknown>): NextRouteHandler {
  return async (req, ctx) => {
    try {
      const mutating = !SAFE_METHODS.has(req.method.toUpperCase());
      if (mutating && opts.origin === 'check') checkOrigin(req);
      return toResponse(await handler({ req, params: await readParams(ctx) }));
    } catch (e) {
      if (isNextControl(e)) throw e;
      const { code, detail } = errorCode(e);
      return jsonError(code, detail);
    }
  };
}

export type PageOptions = GuardOptions;
export type PageContext<P> = { viewer: Viewer; props: P };

function pageFailure(e: unknown): never {
  if (e instanceof UnauthorizedError) redirect(LOGIN_PATH);
  if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
  throw e;
}

/**
 * Страница или layout с данными. Нет сессии — переход на вход; нет права или объекта — notFound():
 * 404 и для раздела, потому что forbidden() в Next 16 экспериментален (D-074). Страница ничего не
 * меняет, поэтому блокировка мутаций к ней не применяется.
 */
export function page<P, R>(opts: PageOptions, loader: (ctx: PageContext<P>) => Promise<R>): (props: P) => Promise<R> {
  return async (props: P) => {
    let viewer: Viewer;
    try {
      viewer = await resolveViewer();
      checkGuard(viewer, opts, false);
    } catch (e) {
      return pageFailure(e);
    }
    try {
      return await loader({ viewer, props });
    } catch (e) {
      if (isNextControl(e)) throw e;
      return pageFailure(e);
    }
  };
}

/** Итог server action: данные или код ошибки (без текста). */
export type ActionResult<R> = { ok: true; data: R } | { ok: false; error: AccessErrorCode | 'internal'; detail?: string };

export type ActionContext = { viewer: Viewer };

export type ActionOptions<A extends unknown[], R> = GuardOptions & {
  audit?: AuditSpec<{ viewer: Viewer; args: A }, R>;
};

/**
 * Server action. Мутация — если разрешение пишущее (или 'authenticated'/'admin'). Origin проверяется
 * всегда и до чтения сессии (D-095, D-153): action — это POST, а Next пропускает его без Origin.
 */
export function action<A extends unknown[], R>(
  opts: ActionOptions<A, R>,
  fn: (ctx: ActionContext, ...args: A) => Promise<R>,
): (...args: A) => Promise<ActionResult<R>> {
  return async (...args: A): Promise<ActionResult<R>> => {
    try {
      await checkActionOrigin();
      const viewer = await resolveViewer();
      checkGuard(viewer, opts, isMutation(opts.perm, true));
      const data = await fn({ viewer }, ...args);
      if (opts.audit) await audit(viewer, opts.audit, { viewer, args }, data);
      return { ok: true, data };
    } catch (e) {
      if (isNextControl(e)) throw e;
      const { code, detail } = errorCode(e);
      return detail ? { ok: false, error: code, detail } : { ok: false, error: code };
    }
  };
}
