// Общие типы схемы настроек: ключи, подписи, время, цвета, шаги. Только типы и диапазоны —
// значений по умолчанию здесь нет (они в presets/base, D-061).
import { z } from 'zod';
import { parseStep, type StepKind } from '../steps.js';

/** Ключ справочника: не меняется после создания, удаления нет — только `archived` (CONFIG §2). */
export const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const Key = z.string().regex(KEY_RE, 'ключ: ^[a-z][a-z0-9_]{1,39}$');

/** Подпись `{ ru, kk }`; пустой или отсутствующий `kk` показывает `ru`. */
export const I18n = z
  .object({
    ru: z.string().trim().min(1).max(200),
    kk: z.string().max(200).optional(),
  })
  .strict();
export type I18nText = z.infer<typeof I18n>;

/** Длинный текст (шаблоны напоминаний). */
export const I18nLong = z
  .object({
    ru: z.string().trim().min(1).max(2000),
    kk: z.string().max(2000).optional(),
  })
  .strict();

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const HHMM = z.string().regex(HHMM_RE, 'время HH:MM');

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Местная дата YYYY-MM-DD, существующая в календаре. */
export const LocalDate = z
  .string()
  .regex(DATE_RE, 'дата YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'несуществующая дата');

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'цвет #RRGGBB');

/** Пояс IANA, который знает tzdata среды. */
export const TimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'неизвестный часовой пояс IANA');

/** Ключ ассета (логотип, шрифт): имя файла без каталогов, чтобы путь не вышел за том ассетов. */
export const AssetKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'ключ ассета: имя файла без каталогов').refine((s) => !s.includes('..'), 'ключ ассета без «..»');

export const IsoWeekday = z.number().int().min(1).max(7);

export const Archived = z.boolean().optional(); // отсутствует = false

/** Шаг времени с ограничением видов. */
export const stepOf = (...kinds: StepKind[]) =>
  z.string().refine((s) => {
    const st = parseStep(s);
    return st !== null && kinds.includes(st.kind);
  }, `шаг: ${kinds.join(' | ')}`);

/** Интервал `{start, end}` в пределах суток, start < end. */
export const TimeRange = z
  .object({ start: HHMM, end: HHMM })
  .strict()
  .refine((r) => r.start < r.end, { message: 'start должен быть раньше end', path: ['end'] });

export type ArraySize = { min?: number; length?: number };
const sized = <T extends z.ZodTypeAny>(a: z.ZodArray<T>, { min, length }: ArraySize) => {
  let out = a;
  if (min !== undefined) out = out.min(min);
  if (length !== undefined) out = out.length(length);
  return out;
};

/** Массив без повторов (для примитивов). */
export const uniqueArray = <T extends z.ZodTypeAny>(item: T, size: ArraySize = {}) =>
  sized(z.array(item), size).refine((a) => new Set(a).size === a.length, 'значения не должны повторяться');

/** Список с полем `key`: ключи уникальны (по ним сливаются слои и ссылаются данные). */
export const keyedList = <T extends z.ZodTypeAny>(item: T, size: ArraySize = {}) =>
  sized(z.array(item), size).superRefine((arr, ctx) => {
    const seen = new Set<string>();
    arr.forEach((el, i) => {
      const k = (el as { key?: unknown }).key;
      if (typeof k !== 'string') return;
      if (seen.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `повтор ключа «${k}»` });
      seen.add(k);
    });
  });
