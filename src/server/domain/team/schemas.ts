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

export const DisableInput = z.object({ mode: z.enum(['urgent', 'wizard']).default('urgent') }).strict();
export type DisableInput = z.infer<typeof DisableInput>;

export const UserId = z.string().min(1).max(64);
