// Манифест изоляции: общий приём вебхуков плагинов (O6, INTEGRATIONS §4). Маршрут публичный (сессии нет, доступ по
// токену пути); прогон с чужим/несуществующим токеном получает 404 и ничего не пишет ни в inbox, ни в подключения.
import { defineManifest } from '../harness/manifest';

export default defineManifest('hooks', [
  {
    kind: 'route',
    path: '/api/hooks/[pluginId]/[token]',
    method: 'POST',
    perm: 'public',
    target: 'section',
    sampleBody: { messages: [{ messageId: 'synthetic-1', chatType: 'whatsapp', chatId: '77090000001', text: 'Синтетика' }] },
    mutation: true,
    touches: ['webhook_inbox', 'integrations'],
  },
]);
