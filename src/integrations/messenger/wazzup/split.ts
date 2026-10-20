// Разбор тела вебхука на строки webhook_inbox (одна строка = одно событие провайдера). Ключи идемпотентности:
// сообщение `m:<messageId>:<isEdited>:<isDeleted>`, статус `s:<messageId>:<status>`, канал `c:<channelId>:<state>:<timestamp>`.
// Из сохраняемого payload выбрасываются qr, contact.avatarUri, contentUri, quotedMessage, oldInfo (минимум ПДн).
// Строка с плохим messageId/channelId пропускается; прочие ключи тела (createContact, templateStatus …) — пусто.
import type { InboxItem, RawRequest } from '../../contract';
import { rawBody, rawChannelUpdate, rawMessage, rawStatus, type StoredMessage } from './schemas';

const KEY_PART = /^[a-z0-9_-]{1,32}$/;

function sanitizeMessage(m: ReturnType<typeof rawMessage.parse>): StoredMessage {
  const out: StoredMessage = { messageId: m.messageId, channelId: m.channelId, chatType: m.chatType, chatId: m.chatId };
  if (m.dateTime !== undefined) out.dateTime = m.dateTime;
  if (m.type !== undefined) out.type = m.type;
  if (m.isEcho !== undefined) out.isEcho = m.isEcho;
  if (m.text !== undefined) out.text = m.text.slice(0, 4096);
  if (m.contentUri) out.hasContent = true;
  if (m.authorId !== undefined) out.authorId = m.authorId;
  if (m.status !== undefined) out.status = m.status;
  if (m.isEdited !== undefined) out.isEdited = m.isEdited;
  if (m.isDeleted !== undefined) out.isDeleted = m.isDeleted;
  const name = m.contact?.name;
  if (typeof name === 'string' && name !== '') out.contactName = name.slice(0, 200);
  return out;
}

export function splitWazzup(req: RawRequest): InboxItem[] {
  const body = rawBody.safeParse(req.json);
  if (!body.success) return [];
  const items: InboxItem[] = [];
  for (const raw of body.data.messages ?? []) {
    const m = rawMessage.safeParse(raw);
    if (!m.success) continue;
    items.push({ dedupeKey: `m:${m.data.messageId}:${m.data.isEdited ? 1 : 0}:${m.data.isDeleted ? 1 : 0}`, kind: 'message', payload: sanitizeMessage(m.data) });
  }
  for (const raw of body.data.statuses ?? []) {
    const s = rawStatus.safeParse(raw);
    const status = s.success ? s.data.status.toLowerCase() : '';
    if (!s.success || !KEY_PART.test(status)) continue;
    items.push({ dedupeKey: `s:${s.data.messageId}:${status}`, kind: 'status', payload: { messageId: s.data.messageId, timestamp: s.data.timestamp, status } });
  }
  for (const raw of body.data.channelsUpdates ?? []) {
    const c = rawChannelUpdate.safeParse(raw);
    const state = c.success ? c.data.state.toLowerCase() : '';
    if (!c.success || !KEY_PART.test(state)) continue;
    const ts = c.data.timestamp === undefined ? 'x' : String(c.data.timestamp).replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'x';
    items.push({ dedupeKey: `c:${c.data.channelId}:${state}:${ts}`, kind: 'channel', payload: { channelId: c.data.channelId, timestamp: c.data.timestamp, state } });
  }
  return items;
}
