// Интеграции: контракт плагина (contract.ts), реестр (registry.ts), пригодность (enablement.ts), HTTP наружу (http.ts),
// плагины telephony.* и messenger.*. Плагины не импортируют друг друга и домен.
export { registry, createRegistry, pluginDeps, PLUGINS, PLUGIN_HOSTS, type PluginDeps } from './registry';
export { pluginUsability } from './enablement';
export { createHttp, PluginHttpError, PLUGIN_HTTP_TIMEOUT_MS } from './http';
