// Окно чата Wazzup в карточке (дизайн docs/reports-plugins-design.md §8.7, D-270). Порядок: карточка видна
// (scopeSql, чужая = несуществующая) → пригодное подключение → номер клиента → канал → сотрудник у провайдера →
// одноразовая ссылка. Имя клиента провайдеру не уходит; ссылка отдаётся только этому сотруднику и нигде не
// сохраняется: ни в логах, ни в аудите (в аудит — только id карточки и канала).
import { NotFoundError, type Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { writeAudit } from '@/server/platform/audit';
import { rateLimit } from '@/server/platform/ratelimit';
import { buildCtx, findUsableIntegration, IntegrationConfigError } from '../integrations';
import { enabledChannels, viewerName, visibleCard, workingMobile, type ChannelRow } from './repo';
import { ChatWindowError, type ChatWindowResult, type MessengerDeps } from './types';

export const CHAT_WINDOW_RATE = 30;

/** Канал для чата: владельца карточки, иначе самого сотрудника, иначе общий; среди равных — рабочий первым. */
export function pickChannel(channels: readonly ChannelRow[], ownerUserId: string | null, viewerUserId: string): ChannelRow | null {
  const rank = (c: ChannelRow): number => (ownerUserId && c.ownerUserId === ownerUserId ? 0 : c.ownerUserId === viewerUserId ? 1 : c.ownerUserId === null ? 2 : 9);
  const live = channels.filter((c) => rank(c) < 9);
  live.sort((a, b) => rank(a) - rank(b) || Number(b.state === 'active') - Number(a.state === 'active') || a.providerChannelId.localeCompare(b.providerChannelId));
  return live[0] ?? null;
}

export async function openChatWindow(viewer: Viewer, deps: MessengerDeps, input: { cardId: string }): Promise<ChatWindowResult> {
  const now = (deps.now ?? Date.now)();
  if (!rateLimit(`chatwin:${viewer.userId}`, CHAT_WINDOW_RATE, 60_000, now).ok) throw new ChatWindowError('rate_limited');
  const db = await getDb();
  const card = await visibleCard(viewer, db.sql, input.cardId);
  if (!card) throw new NotFoundError();

  // Подключение: любой мессенджер с окном провайдера (iframe), пригодный в пространстве карточки
  let found: Awaited<ReturnType<typeof findUsableIntegration>> = null;
  let plugin = null as ReturnType<typeof deps.registry.messenger>;
  for (const p of deps.registry.all()) {
    if (p.kind !== 'messenger' || p.capabilities.chat !== 'iframe') continue;
    found = await findUsableIntegration(deps, card.spaceId, p.id);
    if (found) {
      plugin = deps.registry.messenger(p.id);
      break;
    }
  }
  if (!found || !plugin) throw new ChatWindowError('messenger_unavailable');

  const digits = await workingMobile(viewer, db.sql, card.clientId);
  if (!digits) throw new ChatWindowError('no_phone');
  const channel = pickChannel(await enabledChannels(db.sql, { integrationId: found.id, spaceId: card.spaceId }), card.actingUserId ?? card.ownerUserId, viewer.userId);
  if (!channel) throw new ChatWindowError('no_channel');

  let url: string;
  try {
    const ctx = buildCtx(deps, plugin, found);
    const user = { id: viewer.userId, name: await viewerName(db.sql, viewer.userId) };
    // Сотрудники досылаются лениво: новый или переименованный сотрудник появляется у провайдера перед открытием окна
    if (plugin.syncUsers) {
      const sync = await plugin.syncUsers(ctx, [user]);
      if (!sync.ok) throw new ChatWindowError('provider_error');
    }
    const r = await plugin.openChat(ctx, { user, chat: { chatType: 'whatsapp', chatId: digits, digits }, channelRef: channel.providerChannelId, text: null });
    if (r.kind !== 'iframe') throw new ChatWindowError('provider_error');
    url = r.url;
  } catch (e) {
    if (e instanceof ChatWindowError) throw e;
    if (e instanceof IntegrationConfigError) throw new ChatWindowError('messenger_unavailable');
    throw new ChatWindowError('provider_error');
  }

  await writeAudit(db.sql, { actorId: viewer.userId, action: 'messenger.open_chat', entity: 'messenger', entityId: card.id, spaceId: card.spaceId, meta: { channelId: channel.id } });
  return { url };
}
