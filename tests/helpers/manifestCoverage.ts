// Покрытие манифеста изоляции (ARCHITECTURE §5.3): каждый маршрут, server action, страница и layout с данными
// из src описан в tests/isolation/manifest/<модуль>.ts; записи манифеста не расходятся с обёртками.
import { stripGroups, unitKey, type AppUnit } from './appScan';
import type { ManifestEntry } from '../isolation/harness/manifest';

export type Entry = ManifestEntry & { module: string };

/** Нужна ли единице запись в манифесте: страницы — все; layout — если читает данные. */
export const needsManifest = (u: AppUnit): boolean => (u.kind === 'page' && u.layout ? u.readsData : true);

/** Единица ↔ запись: точный путь (с группами) или путь без групп, если он однозначен среди единиц. */
export function matchEntries(units: readonly AppUnit[], entries: readonly Entry[]): Map<AppUnit, Entry> {
  const strippedCount = new Map<string, number>();
  for (const u of units) strippedCount.set(unitKey(u), (strippedCount.get(unitKey(u)) ?? 0) + 1);
  const out = new Map<AppUnit, Entry>();
  for (const u of units) {
    const exact = entries.find((e) => e.kind === u.kind && e.method === (u.kind === 'action' ? 'POST' : u.method) && e.path === u.path);
    const loose =
      u.kind !== 'action' && (strippedCount.get(unitKey(u)) ?? 0) === 1
        ? entries.find((e) => e.kind === u.kind && e.method === u.method && stripGroups(e.path) === stripGroups(u.path))
        : undefined;
    const hit = exact ?? loose;
    if (hit) out.set(u, hit);
  }
  return out;
}

const describe = (u: AppUnit) => (u.kind === 'action' ? `server action ${u.path}` : `${u.kind === 'route' ? 'route' : u.layout ? 'layout' : 'страница'} ${u.method} ${u.path} (${u.file})`);
const NAME = /^[a-z_][a-z0-9_]*$/;

export function coverageViolations(units: readonly AppUnit[], entries: readonly Entry[], publicRoutes: Readonly<Record<string, string>>): string[] {
  const v: string[] = [];
  const matched = matchEntries(units, entries);
  const used = new Set<Entry>(matched.values());

  for (const u of units) {
    const e = matched.get(u);
    if (!e) {
      if (needsManifest(u)) v.push(`${describe(u)}: нет записи в tests/isolation/manifest/<модуль>.ts`);
      continue;
    }
    const w = u.wrapped;
    if (w) {
      // Разрешение и вид входа в манифесте совпадают с обёрткой: иначе прогон проверяет не то, что стоит в коде
      if (w.fn === 'publicRoute') {
        if (e.perm !== 'public') v.push(`${describe(u)}: обёрнут publicRoute(), в манифесте perm='${e.perm}' (нужно 'public')`);
      } else if (w.perm && e.perm !== w.perm) {
        v.push(`${describe(u)}: в обёртке perm='${w.perm}', в манифесте '${e.perm}'`);
      } else if (!w.perm) {
        v.push(`${describe(u)}: perm в обёртке не строковый литерал — статический обход не может сверить с манифестом`);
      }
      if (w.fn !== 'publicRoute' && (w.target ?? 'section') !== e.target) v.push(`${describe(u)}: в обёртке target='${w.target ?? 'section'}', в манифесте '${e.target}'`);
      if (w.fn !== 'publicRoute' && Boolean(w.securityMutation) !== Boolean(e.securityMutation)) {
        v.push(`${describe(u)}: securityMutation ${w.securityMutation ? 'есть в обёртке, нет' : 'нет в обёртке, есть'} в манифесте`);
      }
      if (w.fn !== 'publicRoute' && e.perm === 'public') v.push(`${describe(u)}: perm='public' допустим только у publicRoute()`);
    }
  }

  for (const e of entries) {
    const where = `манифест ${e.module}: ${e.kind} ${e.method} ${e.path}`;
    if (!used.has(e)) v.push(`${where}: нет такого маршрута/страницы/действия в src (устаревшая запись)`);
    if (e.kind === 'route' && e.perm === 'public' && !(`${e.method} ${stripGroups(e.path)}` in publicRoutes)) {
      v.push(`${where}: perm='public', но маршрута нет в явном списке tests/helpers/staticPolicy.ts`);
    }
    if (e.idParam && e.kind !== 'action' && !e.path.includes(`[${e.idParam.name}]`)) v.push(`${where}: idParam '${e.idParam.name}' не найден в пути`);
    if (e.mutation && (!e.touches || e.touches.length === 0)) v.push(`${where}: мутация без touches — снимок таблиц пустой`);
    if (!e.mutation && e.touches?.length) v.push(`${where}: touches у немутирующей записи`);
    if (e.securityMutation && !e.mutation) v.push(`${where}: securityMutation без mutation`);
    for (const t of e.touches ?? []) if (!NAME.test(t)) v.push(`${where}: недопустимое имя таблицы '${t}'`);
    if (e.perm === 'public' && e.target === 'object') v.push(`${where}: публичная запись не может быть объектной`);
  }
  for (const key of Object.keys(publicRoutes)) {
    const hit = entries.some((e) => e.kind === 'route' && `${e.method} ${stripGroups(e.path)}` === key && e.perm === 'public');
    if (!hit) v.push(`публичный маршрут ${key} из staticPolicy.ts не описан в манифесте с perm='public'`);
  }
  return v;
}
