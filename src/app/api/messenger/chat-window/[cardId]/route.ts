import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { openChatWindow } from '@/server/domain/messenger';
import { cardIdParam, respond } from '../../_lib';

// Окно чата Wazzup в карточке (D-270, D-297). Пишущее действие: сотрудник пишет клиенту от имени компании, поэтому
// разрешение `note.write` — «только чтение» и запирающая лицензия получают 423, роль без права или чужая карточка —
// 404 (target: object). Тела нет: id карточки в пути. Ответ — одноразовая ссылка только этому сотруднику; обёртка
// ставит Cache-Control: no-store. Ссылка не логируется и не попадает в аудит (аудит `messenger.open_chat` пишет
// домен: id карточки и канала).
export const POST = route({ perm: 'note.write', target: 'object' }, ({ params, viewer }) =>
  respond(async () => openChatWindow(viewer, pluginDeps(), { cardId: cardIdParam(params.cardId) })),
);
