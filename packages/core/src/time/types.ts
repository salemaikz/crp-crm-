// Типы модуля времени и рабочего календаря (CONFIG §6.1–6.2). Чистые данные без привязки к компании:
// пояс, рабочие дни, окна и праздники приходят из настроек.

/** Момент времени, epoch-мс (UTC). */
export type Ms = number;
/** Местные сутки в поясе установки, 'YYYY-MM-DD'. */
export type LocalDay = string;
/** Местное время суток, 'HH:MM' (00:00–23:59). */
export type HHMM = string;
/** День недели по ISO: 1 — понедельник … 7 — воскресенье. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Местное время момента в поясе установки (без зависимости от TZ процесса). */
export interface LocalParts {
  readonly day: LocalDay;
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly dayOfMonth: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly weekday: IsoWeekday;
  /** Миллисекунд от местной полуночи по настенным часам: (час·60 + минута)·60000 + секунды·1000 + мс. */
  readonly msOfDay: number;
}

/** Окно часов в рамках одних местных суток; полуоткрытое: `start` входит, `end` уже вне окна. */
export interface HoursWindow {
  readonly start: HHMM;
  readonly end: HHMM;
}

/** Вид строки `calendar.holidays`: выходной (праздник или перенос) либо рабочий день (перенос на выходной). */
export type HolidayKind = 'holiday' | 'workday';

/** Строка `calendar.holidays`; ключ слияния слоёв — `date`. */
export interface CalendarHoliday {
  readonly date: LocalDay;
  readonly kind: HolidayKind;
  readonly note?: string;
}

/** Настройки календаря: `org.timezone` и `calendar.*` (CONFIG §6.1–6.2). */
export interface CalendarSettings {
  /** IANA-имя пояса, например `Asia/Almaty`. */
  readonly timezone: string;
  /** Рабочие дни недели по ISO (`calendar.workdays`), например [1,2,3,4,5]. */
  readonly workdays: readonly number[];
  /** Рабочие часы (`calendar.workHours`). */
  readonly workHours: HoursWindow;
  /** Окно звонков (`calendar.callWindow`). */
  readonly callWindow: HoursWindow;
  /** Праздники и переносы (`calendar.holidays`), уже слитые по `date` или с повторами: победит последняя строка. */
  readonly holidays: readonly CalendarHoliday[];
}

/** Какое окно имеется в виду: рабочие часы или окно звонков. */
export type WindowKind = 'work' | 'call';

/** Причина, по которой день рабочий или нет. */
export type DayReason = 'workday' | 'weekend' | 'holiday' | 'transferred_workday';

/** Сведения о дне для экранов и отчётов («почему день пропущен»). */
export interface DayInfo {
  readonly day: LocalDay;
  readonly workday: boolean;
  readonly reason: DayReason;
  /** Примечание строки `calendar.holidays`, если день из неё. */
  readonly note?: string;
}
