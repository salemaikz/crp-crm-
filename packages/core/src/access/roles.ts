// Раздел ролей документа настроек: `global.roles` (CONFIG §6.10, ARCHITECTURE §5.1 п. 2).
// Роль — шаблон прав: охваты по разрешениям, отношения с закрытым списком действий, «только чтение».
// Схема задаёт только типы, диапазоны и связи; значения по умолчанию — в пресете `base` (D-061).
// P5 импортирует `RolesSchema` в общий документ ConfigV1; доступ парсит этот раздел сам.
import { z } from 'zod';
import { PERMISSIONS, SCOPES } from './catalog';
import { RELATION_KEYS } from './relations';
import { validateRoles } from './roleValidator';

/** Ключ в настройках: `^[a-z][a-z0-9_]{1,39}$` (CONFIG §3.3). Ключ роли не меняется, удаления нет. */
export const CONFIG_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const ConfigKeySchema = z.string().regex(CONFIG_KEY_RE, 'ключ: ^[a-z][a-z0-9_]{1,39}$');

/** Подпись `{ru, kk}`; пустое или отсутствующее `kk` показывает `ru` (CONFIG §2). */
export const RoleLabelSchema = z
  .object({ ru: z.string().trim().min(1).max(80), kk: z.string().max(80).optional() })
  .strict();

export const GrantSchema = z.object({ perm: z.enum(PERMISSIONS), scope: z.enum(SCOPES) }).strict();

const ActionsSchema = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
const NoParams = z.object({}).strict();

/** Параметры отношений. Окно консультанта — в днях относительно даты записи, включительно. */
export const BookedWithMeParamsSchema = z
  .object({ fromDays: z.number().int().min(-7).max(0), toDays: z.number().int().min(0).max(365) })
  .strict();

export const RelationGrantSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('booked_with_me'), params: BookedWithMeParamsSchema, actions: ActionsSchema }).strict(),
  z.object({ key: z.literal('duty_today'), params: NoParams, actions: ActionsSchema }).strict(),
  z.object({ key: z.literal('handoff_to_my_team'), params: NoParams, actions: ActionsSchema }).strict(),
  z.object({ key: z.literal('handoff_assigned_to_me'), params: NoParams, actions: ActionsSchema }).strict(),
]);

export const FIELD_ACCESS = ['edit', 'read', 'hidden'] as const;

export const RoleSchema = z
  .object({
    key: ConfigKeySchema,
    label: RoleLabelSchema,
    /** «Только чтение»: мутации → 423, пишущие разрешения запрещены валидатором. */
    readOnly: z.boolean(),
    grants: z.array(GrantSchema).max(PERMISSIONS.length),
    relations: z.array(RelationGrantSchema).max(RELATION_KEYS.length),
    /** Доступ к полям по умолчанию; точнее — `fields[].access` (движок полей, K2). */
    fieldAccessDefault: z.enum(FIELD_ACCESS),
    /** Ключи пунктов меню оболочки; список пунктов ведёт интерфейс. */
    menu: z.array(ConfigKeySchema).max(30),
    /** Удаления нет: архивная роль не выдаёт прав, ключ остаётся читаемым. */
    archived: z.boolean().optional(),
  })
  .strict();

/** Массив ролей целиком: схема + валидатор опасных сочетаний (roleValidator). */
export const RolesSchema = z
  .array(RoleSchema)
  .min(1)
  .max(50)
  .superRefine((roles, ctx) => {
    for (const issue of validateRoles(roles)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: `${issue.code}: ${issue.message}` });
    }
  });

export type RoleConfig = z.infer<typeof RoleSchema>;
export type RelationGrantConfig = z.infer<typeof RelationGrantSchema>;
export type GrantConfig = z.infer<typeof GrantSchema>;
