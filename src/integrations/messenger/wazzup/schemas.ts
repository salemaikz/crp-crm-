// Схемы тела вебхука Wazzup (разбор по документации API v3). Все схемы терпимы к лишним полям (.passthrough()):
// провайдер добавляет поля без предупреждения; нужные нам — проверяются, остальное отбрасывает split().
import { z } from 'zod';

/** Идентификаторы Wazzup — UUID; допускаем безопасный набор символов (в ключ идемпотентности и SQL попадает только он). */
export const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const id = z.string().regex(ID_RE);

export const rawMessage = z
  .object({
    messageId: id,
    channelId: id,
    chatType: z.string().min(1).max(32),
    chatId: z.string().min(1).max(128),
    dateTime: z.string().max(64).optional(),
    type: z.string().max(32).optional(),
    isEcho: z.boolean().optional(),
    text: z.string().max(20000).optional(),
    contentUri: z.string().max(2000).optional(),
    authorId: z.string().max(128).optional(),
    status: z.string().max(16).optional(),
    isEdited: z.boolean().optional(),
    isDeleted: z.boolean().optional(),
    contact: z.object({ name: z.string().max(500).optional() }).passthrough().optional(),
  })
  .passthrough();

export const rawStatus = z.object({ messageId: id, timestamp: z.union([z.number(), z.string()]).optional(), status: z.string().max(16) }).passthrough();

export const rawChannelUpdate = z.object({ channelId: id, timestamp: z.union([z.number(), z.string()]).optional(), state: z.string().max(64) }).passthrough();

/** Тело вебхука целиком: три массива, любой может отсутствовать. */
export const rawBody = z
  .object({
    messages: z.array(z.unknown()).optional(),
    statuses: z.array(z.unknown()).optional(),
    channelsUpdates: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** То, что остаётся в payload после split(): без qr, avatarUri, contentUri, quotedMessage, oldInfo. */
export const storedMessage = z.object({
  messageId: id,
  channelId: id,
  chatType: z.string(),
  chatId: z.string(),
  dateTime: z.string().optional(),
  type: z.string().optional(),
  isEcho: z.boolean().optional(),
  text: z.string().optional(),
  hasContent: z.boolean().optional(),
  authorId: z.string().optional(),
  status: z.string().optional(),
  isEdited: z.boolean().optional(),
  isDeleted: z.boolean().optional(),
  contactName: z.string().optional(),
});
export type StoredMessage = z.infer<typeof storedMessage>;

export const storedStatus = z.object({ messageId: id, timestamp: z.union([z.number(), z.string()]).optional(), status: z.string() });
export const storedChannel = z.object({ channelId: id, timestamp: z.union([z.number(), z.string()]).optional(), state: z.string() });
