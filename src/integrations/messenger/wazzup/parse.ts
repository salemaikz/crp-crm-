// Чистый разбор строки inbox в нормализованные события (контракт). Неизвестное — пустой массив, не ошибка.
import { normalizeKzDigits } from '@/shared/tel';
import type { DeliveryStatus, InboxItem, MessengerMessageType, NormalizedEvent } from '../../contract';
import { storedChannel, storedMessage, storedStatus } from './schemas';

const STATUSES: ReadonlySet<string> = new Set<DeliveryStatus>(['sent', 'delivered', 'read', 'error', 'inbound']);
const MEDIA: Readonly<Record<string, MessengerMessageType>> = { image: 'image', audio: 'audio', video: 'video', document: 'document' };

/** Время провайдера → epoch-мс. «2026-10-28 09:42:55» без пояса считаем UTC; число < 1e12 — секунды. */
export function toEpochMs(v: string | number | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e12 ? Math.round(v * 1000) : Math.round(v)) : null;
  if (typeof v !== 'string' || v === '') return null;
  if (/^\d+$/.test(v)) return toEpochMs(Number(v));
  const iso = v.includes('T') ? v : v.replace(' ', 'T');
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(t) ? null : t;
}

const DIGITS = /^\d{10,15}$/;

export function parseWazzup(kind: InboxItem['kind'], payload: unknown): NormalizedEvent[] {
  if (kind === 'message') {
    const p = storedMessage.safeParse(payload);
    if (!p.success) return [];
    const m = p.data;
    const sentAt = toEpochMs(m.dateTime);
    if (sentAt === null) return [];
    const direction = m.isEcho === true ? 'out' : 'in';
    const t = (m.type ?? 'text').toLowerCase();
    const msgType: MessengerMessageType = t === 'missing_call' ? 'missing_call' : t === 'text' ? 'text' : (MEDIA[t] ?? 'other');
    const digits = m.chatType === 'whatsapp' ? normalizeKzDigits(m.chatId) : '';
    const status = m.status && STATUSES.has(m.status.toLowerCase()) ? (m.status.toLowerCase() as DeliveryStatus) : null;
    return [
      {
        type: 'message',
        channelRef: m.channelId,
        chatType: m.chatType,
        chatId: m.chatId,
        chatDigits: DIGITS.test(digits) ? digits : '',
        providerMessageId: m.messageId,
        direction,
        msgType,
        text: m.isDeleted ? null : (m.text?.slice(0, 4096) ?? null),
        hasAttachment: m.hasContent === true || msgType === 'image' || msgType === 'audio' || msgType === 'video' || msgType === 'document',
        status,
        authorRef: direction === 'out' && m.authorId ? m.authorId : null,
        sentAt,
        isEdited: m.isEdited === true,
        isDeleted: m.isDeleted === true,
        contactName: m.contactName ? m.contactName.slice(0, 200) : null,
      },
    ];
  }
  if (kind === 'status') {
    const p = storedStatus.safeParse(payload);
    const status = p.success ? p.data.status.toLowerCase() : '';
    if (!p.success || !STATUSES.has(status)) return [];
    const at = toEpochMs(p.data.timestamp);
    if (at === null) return [];
    return [{ type: 'status', providerMessageId: p.data.messageId, status: status as DeliveryStatus, at }];
  }
  if (kind === 'channel') {
    const p = storedChannel.safeParse(payload);
    if (!p.success) return [];
    const at = toEpochMs(p.data.timestamp);
    if (at === null) return [];
    return [{ type: 'channel', channelRef: p.data.channelId, state: p.data.state.toLowerCase(), at }];
  }
  return [];
}
