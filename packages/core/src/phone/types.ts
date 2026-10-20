// Типы модуля номеров. Правила (страна, префиксы) приходят параметром из настроек
// `global.phone` (CONFIG §6.3), ядро их не хранит.

/** Тип номера в `client_phones.kind`. */
export type PhoneKind = 'mobile' | 'landline' | 'unknown';

/**
 * Правила номеров = `global.phone` (CONFIG §6.3). Префикс — национальная часть номера без «7»;
 * `x` в префиксе — любая цифра (`71x` = 710…719). Допустимы префиксы любой длины (`7172`).
 */
export interface PhoneRules {
  /** `phone.country`. Сейчас поддержан `KZ` (канон `7XXXXXXXXXX`). */
  country: 'KZ';
  /** `phone.mobilePrefixes`. */
  mobilePrefixes: readonly string[];
  /** `phone.reviewPrefixes`: мобильные с отметкой «проверить номер» (PROCESS, вопрос 7). */
  reviewPrefixes: readonly string[];
  /** `phone.landlinePrefixes`. */
  landlinePrefixes: readonly string[];
  /**
   * Дополнительные заглушки: точные номера в каноне `7XXXXXXXXXX`. Ключа в CONFIG пока нет
   * (правила заглушек — код), поле необязательное.
   */
  stubs?: readonly string[];
}

/** Почему номер нерабочий (`working = false`). */
export type PhoneInvalidReason =
  | 'too_short' // меньше 10 цифр: обрывок или городской без кода
  | 'too_long' // больше 11 цифр
  | 'foreign' // 11 цифр, но не с 7 и не с 8
  | 'bad_code' // код региона начинается с 0, 1 или 2
  | 'placeholder'; // заглушка: одинаковые цифры, пустой абонентский номер, список `stubs`

export interface ParsedPhone {
  /** Исходный фрагмент ячейки (обрезанный по краям), для отчёта импорта. */
  raw: string;
  /**
   * Канон `7XXXXXXXXXX`, если фрагмент имеет форму российско-казахстанского номера (в т. ч.
   * заглушка — ею пользуются для дедупа заглушек); иначе `null`. Рабочий ли номер — смотри `working`.
   */
  digits: string | null;
  /** `+7XXXXXXXXXX` для `digits !== null`. */
  e164: string | null;
  /** Номер годится для звонка: `digits !== null` и не заглушка. */
  working: boolean;
  kind: PhoneKind;
  /** Мобильный с префиксом из `reviewPrefixes`: показать «проверить номер». */
  needsReview: boolean;
  /** Добавочный (только цифры), иначе пустая строка. */
  ext: string;
  /** Причина, по которой `working = false`; для рабочего `null`. */
  invalidReason: PhoneInvalidReason | null;
}
