// Типы модуля интеграций (дизайн docs/reports-plugins-design.md §7, D-268). Домен видит плагины только через
// контракт: реестр, правило пригодности и HTTP приходят в deps (их собирает pluginDeps() из src/integrations).
import type { PluginFlag, PluginHttp, PluginId, PluginRegistry, PluginUsabilityOf } from '@/integrations/contract';

export interface IntegrationDeps {
  registry: PluginRegistry;
  usability: PluginUsabilityOf;
  /** HTTP наружу только на хосты провайдера этого плагина. */
  http: (pluginId: PluginId) => PluginHttp;
  /** Подмены для тестов; по умолчанию — флаги окружения, лицензия процесса, APP_ORIGIN и часы. */
  flagOn?: (flag: PluginFlag) => boolean;
  licensed?: (feature: string) => Promise<boolean>;
  appOrigin?: string;
  now?: () => number;
}

/** Строка integrations без секретов и хэша токена. */
export interface IntegrationRow {
  id: string;
  pluginId: string;
  spaceId: string | null;
  config: unknown;
  enabled: boolean;
  status: string;
  lastEventAt: number | null;
  crossborderApprovedAt: number | null;
}

/** Строка webhook_inbox для обработчика воркера. payload = null — обнулён чисткой через 14 дней. */
export interface InboxRow {
  id: string;
  integrationId: string;
  pluginId: string;
  kind: string;
  payload: unknown;
}
