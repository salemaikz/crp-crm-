// Ключи настроек воронки v2 (docs/pipeline-v2-design.md §8.1, §15.1). Все необязательны: нет ключа — прежнее
// поведение. Вносятся в схему v1 до заморозки 0.9.0 (D-346): после первого выпуска форма не меняется.
// Ссылочные проверки — integrityPipelineV2.ts.
import { z } from 'zod';
import { CARD_STATES } from '../../calling/spec/types.js';
import { Archived, HexColor, IsoWeekday, Key, keyedList, I18n, uniqueArray } from './primitives.js';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** Системные причины: какую причину система ставит сама (§4.1). */
export const REASON_SYSTEMS = ['no_show', 'attended_no_purchase', 'client_return', 'return_due', 'write_off'] as const;

/** Необязательные ключи `Reason` (§4.1). */
export const reasonExtra = {
  system: z.enum(REASON_SYSTEMS).optional(),
  /** Ключи `booking.eventTypes[]`; для `system: no_show`. */
  eventTypes: uniqueArray(Key).optional(),
  /** `false` — причину ставит только система; нет ключа = `true`. */
  manual: z.boolean().optional(),
};

/** Шаг подсказки срока перезвона: `+Nd` или `+Nd@HH:MM`, N = 1..365. */
const SCHEDULE_STEP_RE = /^\+([1-9]\d{0,2})d(@([01]\d|2[0-3]):[0-5]\d)?$/;
export const CallbackScheduleStep = z
  .string()
  .regex(SCHEDULE_STEP_RE, 'шаг: +Nd или +Nd@HH:MM')
  .refine((s) => Number(SCHEDULE_STEP_RE.exec(s)?.[1]) <= 365, 'N от 1 до 365');

export const callingExtra = {
  callbackReason: obj({ required: z.boolean() }).optional(),
  callbackSchedule: obj({ steps: z.array(CallbackScheduleStep).min(1).max(10) }).optional(),
};

const Weight = int(0, 10000);
export const queueExtra = {
  sort: z.enum(['groups', 'heat']).optional(),
  heat: obj({
    states: z.record(z.enum(CARD_STATES), Weight),
    reasons: z.record(Key, Weight).refine((r) => Object.keys(r).length <= 50, 'причин в весах не больше 50'),
    flags: obj({ attendedGroup: Weight, attendedIndividual: Weight, noShow: Weight, purchased: Weight, lprYes: Weight }),
  }).optional(),
};

export const TONES = ['success', 'warning', 'info', 'danger', 'neutral'] as const;

const BoardColumn = obj({
  key: Key,
  label: I18n,
  states: uniqueArray(z.enum(CARD_STATES), { min: 1 }),
  /** Виды мероприятий (`booking.eventTypes[]`); только у колонки с `agreed`. */
  eventTypes: uniqueArray(Key).optional(),
  recentDays: int(1, 3650).optional(),
  drop: z.array(obj({ kind: Key, reason: Key })).max(20).optional(),
  dropMore: z.boolean().optional(),
});

export const Board = obj({
  columns: keyedList(BoardColumn, { min: 1 }),
  agreedFallback: Key.optional(),
  tones: z
    .array(obj({ when: z.enum(['attendedIndividual', 'attendedGroup', 'noShow', 'purchased']), tone: z.enum(TONES) }))
    .max(20)
    .optional(),
});

export const ThemeDark = obj({
  canvas: HexColor.optional(),
  surface: HexColor.optional(),
  brandColor: HexColor.optional(),
  accentColor: HexColor.optional(),
  // Светлая плашка под логотипом в тёмной теме: по умолчанию есть (тёмный логотип не пропадёт на тёмном фоне);
  // false — логотип с прозрачным фоном, рассчитанный на тёмный фон, стоит без плашки.
  logoPlate: z.boolean().optional(),
});
export const themeExtra = {
  defaultMode: z.enum(['system', 'light', 'dark']).optional(),
  dark: ThemeDark.optional(),
};

/** Верхняя граница суммы, как у покупки (`AMOUNT_MAX_KZT` сервера). */
const AMOUNT_MAX_KZT = 1_000_000_000_000;

/**
 * Вариант услуги с фиксированной ценой (D-348, ВП-1): покупка подставляет цену варианта, сумму можно поправить
 * (скидка). Нет вариантов — сумму вводит сотрудник, как раньше.
 */
const ServiceVariant = obj({ key: Key, label: I18n, amountKzt: int(1, AMOUNT_MAX_KZT), archived: Archived });
export const serviceTypeExtra = {
  variants: keyedList(ServiceVariant).optional(),
};

/**
 * Обзвон подтверждения явки (D-349, ВП-2): в дни `weekdays` записанные на ближайшее мероприятие видов `eventTypes`
 * стоят у оператора наверху; ответ «не придёт» — перезвон с причиной `declineReason` из `reasons.callback`.
 */
export const bookingExtra = {
  confirmCall: obj({
    eventTypes: uniqueArray(Key, { min: 1 }),
    weekdays: uniqueArray(IsoWeekday, { min: 1 }),
    declineReason: Key,
  }).optional(),
};
