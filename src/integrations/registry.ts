// Статический реестр плагинов (INTEGRATIONS §1, D-268): собираются в образ, во время работы ничего не подгружается.
// Новый провайдер — файл плагина и строка в PLUGINS (messenger.wazzup — O7a, telephony.zadarma — O7b).
// Домен реестр не импортирует: получает PluginRegistry в deps (маршрут, оболочка, воркер — pluginDeps()).
import type { AnyPlugin, MessengerPlugin, PluginHttp, PluginId, PluginRegistry, PluginUsabilityOf, TelephonyPlugin } from './contract';
import { pluginUsability } from './enablement';
import { createHttp } from './http';
import { waLinkMessenger } from './messenger/wa-link';
import { wazzupMessenger } from './messenger/wazzup';
import { WAZZUP_API_HOST } from './messenger/wazzup/types';
import { beelineTelephony } from './telephony/beeline';
import { manualTelephony } from './telephony/manual';

/** Порядок важен: первая пригодная телефония пространства побеждает, manual и wa_link — запасные. */
export const PLUGINS: readonly AnyPlugin[] = [manualTelephony, beelineTelephony, waLinkMessenger, wazzupMessenger];

export function createRegistry(plugins: readonly AnyPlugin[]): PluginRegistry {
  const byId = new Map<PluginId, AnyPlugin>();
  for (const p of plugins) {
    if (byId.has(p.id)) throw new Error(`реестр плагинов: дубль ${p.id}`);
    byId.set(p.id, p);
  }
  return {
    get: (id) => byId.get(id) ?? null,
    telephony: (id) => {
      const p = byId.get(id);
      return p && p.kind === 'telephony' ? (p as TelephonyPlugin) : null;
    },
    messenger: (id) => {
      const p = byId.get(id);
      return p && p.kind === 'messenger' ? (p as MessengerPlugin) : null;
    },
    all: () => plugins,
  };
}

export const registry: PluginRegistry = createRegistry(PLUGINS);

/** Хосты провайдеров (INTEGRATIONS §8): плагин ходит наружу только на свои. manual и wa_link наружу не ходят. */
export const PLUGIN_HOSTS: Readonly<Partial<Record<PluginId, readonly string[]>>> = {
  'messenger.wazzup': [WAZZUP_API_HOST],
};

/** Что домену нужно от интеграций: реестр, правило пригодности и HTTP наружу на хосты плагина. */
export interface PluginDeps {
  registry: PluginRegistry;
  usability: PluginUsabilityOf;
  http: (pluginId: PluginId) => PluginHttp;
}

export function pluginDeps(): PluginDeps {
  return { registry, usability: pluginUsability, http: (pluginId) => createHttp(PLUGIN_HOSTS[pluginId] ?? []) };
}
