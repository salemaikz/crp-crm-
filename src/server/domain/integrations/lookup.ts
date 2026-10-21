// Поиск подключений для других модулей (мессенджер): подключение плагина в пространстве, пригодное прямо сейчас.
import { getDb } from '@/server/platform/db';
import { getIntegrationRow, listSpaceIntegrations } from './repo';
import { usabilityOf } from './service';
import type { IntegrationDeps, IntegrationRow } from './types';

/** Первое пригодное (флаг ∧ лицензия ∧ включено ∧ решение о передаче) подключение плагина в пространстве. */
export async function findUsableIntegration(deps: IntegrationDeps, spaceId: string, pluginId: string): Promise<IntegrationRow | null> {
  const plugin = deps.registry.get(pluginId as never);
  if (!plugin) return null;
  const rows = await listSpaceIntegrations((await getDb()).sql, spaceId);
  for (const row of rows.filter((r) => r.pluginId === pluginId)) {
    if ((await usabilityOf(deps, plugin, row)).usable) return row;
  }
  return null;
}

export async function loadIntegrationRow(id: string): Promise<IntegrationRow | null> {
  return getIntegrationRow((await getDb()).sql, id);
}
