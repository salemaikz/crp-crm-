// Входные данные API: проверка Zod на границе, лишние поля отклоняются.
import { z } from 'zod';
import { loginPhoneDigits } from '@/server/platform/auth/login';

const roleKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export const InviteInput = z
  .object({
    phone: z.string().max(40).refine((v) => loginPhoneDigits(v) !== null, 'phone'),
    name: z.string().trim().min(1).max(100),
    /** null — администратор без роли в пространстве. */
    roleKey: roleKey.nullable(),
    isAdmin: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.roleKey !== null || v.isAdmin === true, { message: 'role_required', path: ['roleKey'] });
export type InviteInput = z.infer<typeof InviteInput>;

export const ResendInput = z.object({ roleKey: roleKey.optional() }).strict();
export type ResendInput = z.infer<typeof ResendInput>;

export const UpdateInput = z
  .object({ roleKey: roleKey.optional(), isAdmin: z.boolean().optional() })
  .strict()
  .refine((v) => v.roleKey !== undefined || v.isAdmin !== undefined, { message: 'empty' });
export type UpdateInput = z.infer<typeof UpdateInput>;

export const UserId = z.string().min(1).max(64);

/** Кому передаются карточки: одному или «поровну» между 2–20 сотрудниками (B9a). */
export const TransferTo = z.union([
  z.object({ userId: UserId }).strict(),
  z.object({ even: z.array(UserId).min(2).max(20).refine((a) => new Set(a).size === a.length, 'duplicate') }).strict(),
]);
export type TransferTo = z.infer<typeof TransferTo>;

/** Отключение: «срочно» (по умолчанию) или с мастером (получатель одному или поровну; без `to` — как «срочно»). */
export const DisableInput = z
  .object({ mode: z.enum(['urgent', 'wizard']).default('urgent'), to: TransferTo.optional() })
  .strict()
  .refine((v) => v.to === undefined || v.mode === 'wizard', { message: 'to_needs_wizard', path: ['to'] });
export type DisableInput = z.infer<typeof DisableInput>;

const OpId = z.string().uuid();
const TransferScope = z.enum(['working', 'all']);

export const TransferOneInput = z
  .object({ opId: OpId, cardId: UserId, version: z.number().int().min(0), toUserId: UserId })
  .strict();
export type TransferOneInput = z.infer<typeof TransferOneInput>;

export const TransferBulkInput = z.object({ opId: OpId, fromUserId: UserId, scope: TransferScope, to: TransferTo }).strict();
export type TransferBulkInput = z.infer<typeof TransferBulkInput>;

export const TransferPreviewQuery = z.object({ from: UserId, scope: TransferScope.default('working') }).strict();
export type TransferPreviewQuery = z.infer<typeof TransferPreviewQuery>;
