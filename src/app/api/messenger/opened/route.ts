import { route } from '@/server/access';
import { recordLinkOpened } from '@/server/domain/messenger';
import { OpenedBody, readJson } from '../_lib';

// «Открыт WhatsApp, шаблон X» в ленту клиента — без текста переписки (INTEGRATIONS §3.1). Клиент шлёт без ожидания.
export const POST = route({ perm: 'card.read' }, async ({ req, viewer }) => recordLinkOpened(viewer, await readJson(req, OpenedBody)));
