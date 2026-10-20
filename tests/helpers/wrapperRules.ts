// Правила обёрток (ARCHITECTURE §5.2, §5.3): каждый route handler, server action и страница/layout,
// читающие данные, обёрнуты в route/publicRoute/action/page из src/server/access. Чистая функция над
// результатом AST-разбора (appScan), поэтому самопроверка гоняет её на заведомо плохих примерах.
import { unitKey, type AppUnit } from './appScan';

export type WrapperPolicy = {
  /** Публичные маршруты (publicRoute): 'METHOD /путь' → зачем открыт без сессии. Других публичных нет. */
  publicRoutes: Readonly<Record<string, string>>;
  /** Намеренно без обёртки: не читает данные и не ходит в БД (healthcheck). */
  unwrappedByDesign: readonly string[];
  /** Ещё не обёрнуто (переходный долг, у каждой записи свой владелец). Запись, которая уже обёрнута, — ошибка: убери из списка. */
  legacyUnwrapped: Readonly<Record<string, string>>;
};

const WRAPPER_FOR: Record<AppUnit['kind'], readonly string[]> = {
  route: ['route', 'publicRoute'],
  page: ['page'],
  action: ['action'],
};

const where = (u: AppUnit) => `${u.file} (${u.kind === 'action' ? u.exportName : unitKey(u)})`;

export function wrapperViolations(units: readonly AppUnit[], policy: WrapperPolicy): string[] {
  const v: string[] = [];
  const seenUnwrapped = new Set<string>();
  const seen = new Map<string, AppUnit>();
  for (const u of units) {
    const key = unitKey(u);
    seen.set(key, u);
    const unwrappedOk = key in policy.legacyUnwrapped || policy.unwrappedByDesign.includes(key);
    if (u.kind === 'page' && !u.readsData) {
      // страница без данных (форма входа, заглушка): обёртка не обязательна, но чужая обёртка — ошибка
      if (u.wrapped && !WRAPPER_FOR.page.includes(u.wrapped.fn)) v.push(`${where(u)}: на странице обёртка ${u.wrapped.fn}(), нужна page()`);
      continue;
    }
    if (!u.wrapped) {
      if (unwrappedOk) {
        seenUnwrapped.add(key);
        continue;
      }
      const what = u.kind === 'route' ? 'route handler без обёртки route()/publicRoute()' : u.kind === 'action' ? 'server action без обёртки action()' : `страница/layout читает данные (${u.dataReason ?? '?'}) без обёртки page()`;
      v.push(`${where(u)}: ${what}`);
      continue;
    }
    if (!WRAPPER_FOR[u.kind].includes(u.wrapped.fn)) {
      v.push(`${where(u)}: обёртка ${u.wrapped.fn}() не подходит для ${u.kind} (нужна ${WRAPPER_FOR[u.kind].join('/')}())`);
      continue;
    }
    if (u.wrapped.fn === 'publicRoute' && !(key in policy.publicRoutes)) v.push(`${where(u)}: публичный маршрут вне явного списка tests/helpers/staticPolicy.ts`);
    if (key in policy.legacyUnwrapped) v.push(`${where(u)}: уже обёрнут — удали ${key} из legacyUnwrapped`);
  }
  for (const key of Object.keys(policy.legacyUnwrapped)) {
    if (!seenUnwrapped.has(key)) v.push(`legacyUnwrapped: ${key} — нет такой необёрнутой единицы (устаревшая запись)`);
  }
  for (const key of Object.keys(policy.publicRoutes)) {
    const u = seen.get(key);
    if (!u) v.push(`publicRoutes: ${key} — маршрута нет в src/app`);
    else if (u.wrapped && u.wrapped.fn !== 'publicRoute') v.push(`publicRoutes: ${key} объявлен публичным, но обёрнут ${u.wrapped.fn}()`);
    else if (!u.wrapped && !(key in policy.legacyUnwrapped) && !policy.unwrappedByDesign.includes(key)) v.push(`publicRoutes: ${key} без обёртки`);
  }
  for (const key of policy.unwrappedByDesign) {
    if (!seen.has(key)) v.push(`unwrappedByDesign: ${key} — маршрута нет в src/app`);
  }
  return v;
}
