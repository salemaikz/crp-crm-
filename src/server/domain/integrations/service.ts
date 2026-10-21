// Пригодность подключения (D-268): флаг ∧ лицензия ∧ включено ∧ решение о передаче за рубеж. Правило — чистая
// функция из deps (src/integrations/enablement.ts), здесь — сбор входа: окружение, лицензия, строка integrations.
import { license as coreLicense } from '@crm/core';
import type { AnyPlugin, PluginFlag, PluginGate, PluginUsability } from '@/integrations/contract';
import type { SystemActor } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import { currentLicenseSnapshot } from '@/server/platform/license';
import { clearInboxPayloads, loadInboxRow } from './repo';
import type { InboxRow, IntegrationDeps, IntegrationRow } from './types';

export const defaultFlagOn = (flag: PluginFlag): boolean => isFeatureEnabled(flag);

export async function defaultLicensed(feature: string): Promise<boolean> {
  return coreLicense.hasFeature(await currentLicenseSnapshot(), feature);
}

/**
 * Вход правила пригодности. Лицензия читается, только если флаг включён (дешевле и не трогает лицензию у
 * выключенных модулей). `ignoreEnabled` — для «Включить»: пригодность без учёта самого переключателя.
 */
export async function gateFor(deps: IntegrationDeps, plugin: AnyPlugin, row: IntegrationRow | null, opts: { ignoreEnabled?: boolean } = {}): Promise<PluginGate> {
  const flagOn = plugin.flag ? (deps.flagOn ?? defaultFlagOn)(plugin.flag) : true;
  const licensed = !plugin.licenseFeature ? true : flagOn ? await (deps.licensed ?? defaultLicensed)(plugin.licenseFeature) : false;
  const enabled = !plugin.needsConnection || opts.ignoreEnabled === true || row?.enabled === true;
  return { flagOn, licensed, enabled, crossBorderApproved: row?.crossborderApprovedAt != null };
}

export async function usabilityOf(deps: IntegrationDeps, plugin: AnyPlugin, row: IntegrationRow | null, opts: { ignoreEnabled?: boolean } = {}): Promise<PluginUsability> {
  return deps.usability(plugin, await gateFor(deps, plugin, row, opts));
}

/** Для обработчика очереди воркера: строка inbox с плагином подключения. */
export async function loadInboxItem(_actor: SystemActor, id: string): Promise<InboxRow | null> {
  return loadInboxRow((await getDb()).sql, id);
}

/** Для `purge` воркера: payload входящих вебхуков старше `before` обнуляется. Возвращает число строк. */
export async function purgeWebhookPayloads(_actor: SystemActor, before: number): Promise<number> {
  return clearInboxPayloads((await getDb()).sql, before);
}
