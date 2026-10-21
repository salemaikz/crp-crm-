import { route } from '@/server/access';
import { recordLinkOpened } from '@/server/domain/messenger';
import { OpenedBody, readJson, respond } from '../_lib';

// «Открыт WhatsApp, шаблон X» в ленту клиента — без текста переписки (INTEGRATIONS §3.1). Клиент шлёт без ожидания.
// Запись в ленту — мутация (D-297): разрешение `note.write`, «только чтение» и запирающая лицензия — 423; лимит
// частоты на сотрудника — 429.
export const POST = route({ perm: 'note.write' }, ({ req, viewer }) => respond(async () => recordLinkOpened(viewer, await readJson(req, OpenedBody))));
