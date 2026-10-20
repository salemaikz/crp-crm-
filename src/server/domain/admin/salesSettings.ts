// Сервис «Настройки продаж» (R2b, D-267): чтение и запись разрешённых путей настроек через ревизии.
// SQL здесь нет: читаем getActiveConfig, пишем writeConfig (source='ui', expectedRev, аудит `config.write`
// пишет сама запись). Вызывается только из обёрток route()/page().
import { can } from '@/server/access/viewer';
import { ForbiddenError } from '@/server/access/errors';
import type { Viewer } from '@/server/access/types';
import { getActiveConfig } from '@/server/platform/config/active';
import { ConfigConflictError, writeConfig } from '@/server/platform/config/write';
import { config as coreConfig } from '@crm/core';
import type { Json, JsonObject } from '@crm/core/config';
import { SettingsConflictError, SettingsInvalidError, SettingsNoSpaceError } from './errors';
import { crossIssues, HOLIDAYS_PATH, patchPaths, type Holiday, type HolidaysInput, type SalesPatchInput } from './salesSettingsPaths';
import type { SalesSettingsView } from './types';

const { ConfigInvalidError } = coreConfig;

type Active = Awaited<ReturnType<typeof getActiveConfig>>;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Ключ пространства зрителя; администратор без роли — единственное пространство, если оно одно. */
function spaceKeyOf(cfg: Active, viewer: Viewer): string | null {
  const entries = Object.entries(cfg.spaces);
  if (viewer.spaceId) return entries.find(([, s]) => s.spaceId === viewer.spaceId)?.[0] ?? null;
  return viewer.isAdmin && entries.length === 1 ? entries[0]![0] : null;
}

function viewOf(cfg: Active, viewer: Viewer): SalesSettingsView {
  const key = spaceKeyOf(cfg, viewer);
  const space = key ? obj(cfg.spaces[key]!.doc) : null;
  const dist = obj(space?.distribution);
  const sched = obj(dist.schedule);
  const calendar = obj(obj(cfg.global.doc).calendar);
  const win = obj(calendar.callWindow);
  const holidays = calendar.holidays;
  return {
    revs: { global: cfg.global.rev, space: key ? cfg.spaces[key]!.rev : 0 },
    values: {
      dailyCap: space ? (dist.dailyCap as number) : null,
      schedule: space ? { from: sched.from as string, to: sched.to as string, everyMin: sched.everyMin as number } : null,
      callWindow: { start: win.start as string, end: win.end as string },
      callsPerHourTarget: space ? ((obj(space.reports).callsPerHourTarget as number | null | undefined) ?? null) : null,
    },
    holidays: (Array.isArray(holidays) ? (holidays as Holiday[]) : []).map((h) => ({ date: h.date, kind: h.kind, note: h.note })),
    can: { sales: key !== null && can(viewer, 'settings.sales'), holidays: viewer.isAdmin },
    year: Number(viewer.today.slice(0, 4)),
  };
}

/** Настройки для экрана. Нет права `settings.sales` и не администратор — 403. */
export async function getSalesSettings(viewer: Viewer): Promise<SalesSettingsView> {
  if (!can(viewer, 'settings.sales') && !viewer.isAdmin) throw new ForbiddenError();
  return viewOf(await getActiveConfig(), viewer);
}

/** Запись с переводом ошибок ревизий в ошибки модуля. */
async function write(input: Parameters<typeof writeConfig>[0]): Promise<void> {
  try {
    await writeConfig(input);
  } catch (e) {
    if (e instanceof ConfigConflictError) throw new SettingsConflictError();
    if (e instanceof ConfigInvalidError) throw new SettingsInvalidError(e.issues.map((i: { path: string }) => ({ path: i.path })));
    throw e;
  }
}

/** Глубокая копия документа области: правим копию, а не кэшированный объект. */
const clone = (doc: unknown): JsonObject => structuredClone(doc) as JsonObject;

/** Патч разрешённых путей. Пишутся только изменившиеся области. */
export async function patchSalesSettings(viewer: Viewer, input: SalesPatchInput): Promise<SalesSettingsView> {
  const cfg = await getActiveConfig();
  const key = spaceKeyOf(cfg, viewer);
  if (!key) throw new SettingsNoSpaceError();
  const space = cfg.spaces[key]!;
  const { patch } = input;
  const paths = patchPaths(patch);
  if (paths.length === 0) throw new SettingsInvalidError([{ path: 'patch' }]);

  const spaceDoc = clone(space.doc);
  const globalDoc = clone(cfg.global.doc);
  const dist = obj(spaceDoc.distribution);
  const sched = obj(dist.schedule);
  const win = obj(obj(globalDoc.calendar).callWindow);

  if (patch.dailyCap !== undefined) dist.dailyCap = patch.dailyCap;
  Object.assign(sched, patch.schedule ?? {});
  Object.assign(win, patch.callWindow ?? {});
  if (patch.callsPerHourTarget !== undefined) obj(spaceDoc.reports).callsPerHourTarget = patch.callsPerHourTarget;

  const bad = crossIssues(
    { from: sched.from as string, to: sched.to as string, start: win.start as string, end: win.end as string },
    patch,
  );
  if (bad.length > 0) throw new SettingsInvalidError(bad);

  const touchesSpace = paths.some((p) => !p.startsWith('calendar.'));
  const touchesGlobal = paths.some((p) => p.startsWith('calendar.'));
  await write({
    docs: { ...(touchesGlobal ? { global: globalDoc } : {}), ...(touchesSpace ? { spaces: { [key]: spaceDoc } } : {}) },
    source: 'ui',
    expectedRev: { global: input.expectedRev.global, [key]: input.expectedRev.space },
    authorId: viewer.userId,
    note: `ui: ${paths.join(', ')}`,
  });
  return viewOf(await getActiveConfig(), viewer);
}

/** Праздники и переносы: только администратор, область global. Список заменяется целиком, в порядке дат. */
export async function putHolidays(viewer: Viewer, input: HolidaysInput): Promise<SalesSettingsView> {
  if (!viewer.isAdmin) throw new ForbiddenError();
  const cfg = await getActiveConfig();
  const globalDoc = clone(cfg.global.doc);
  const holidays = [...input.holidays].sort((a, b) => (a.date < b.date ? -1 : 1));
  obj(globalDoc.calendar).holidays = holidays as unknown as Json;
  await write({
    docs: { global: globalDoc },
    source: 'ui',
    expectedRev: { global: input.expectedRev.global },
    authorId: viewer.userId,
    note: `ui: ${HOLIDAYS_PATH}`,
  });
  return viewOf(await getActiveConfig(), viewer);
}
