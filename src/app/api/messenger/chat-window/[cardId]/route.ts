import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { openChatWindow } from '@/server/domain/messenger';
import { ChatWindowBody, readJson, respond } from '../_lib';

// Окно чата Wazzup в карточке (D-270): карточка видна сотруднику (чужая = 404), подключение пригодно, канал выбран.
// Ответ — одноразовая ссылка только этому сотруднику; обёртка ставит Cache-Control: no-store. Ссылка не логируется
// и не попадает в аудит (аудит `messenger.open_chat` пишет домен: id карточки и канала).
export const POST = route({ perm: 'card.read' }, ({ req, viewer }) =>
  respond(async () => {
    const body = await readJson(req, ChatWindowBody);
    return openChatWindow(viewer, pluginDeps(), body);
  }),
);
