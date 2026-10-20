// Типы раздачи (PROCESS 7, CONFIG 6.7). Всё, что зависит от компании (лимит, часы, режим, состав
// лимита), приходит настройками `distribution.*`; в ядре нет ни одного значения-константы компании.

export type Ms = number;
export type UserId = string;
/** Местные сутки, 'YYYY-MM-DD'. */
export type LocalDay = string;
/** Местное время 'HH:MM'. */
export type HHMM = string;

export type DistributionMode = 'auto_even' | 'top_up' | 'manual' | 'off';

/** Виды выдачи в журнале раздачи (PROCESS 7.9) и в `distribution.capIncludes`. */
export type IssueKind = 'auto' | 'manual' | 'return' | 'inbound' | 'proposal';

export interface DistributionSchedule {
  from: HHMM;
  to: HHMM;
  everyMin: number;
  workdaysOnly: boolean;
}

export interface DistributionSettings {
  mode: DistributionMode;
  schedule: DistributionSchedule;
  /** Лимит новых карточек на оператора за рабочий день. */
  dailyCap: number;
  /** Какие виды выдачи входят в лимит. */
  capIncludes: readonly IssueKind[];
  /** Разрешена ли ручная раздача сверх остатка лимита (в пилотной настройке: нет). */
  capOverride: boolean;
  /** Для `top_up`: сколько новых держать у каждого в очереди. */
  topUpKeep: number;
}

/**
 * Календарь установки для раздачи. Реализация — `core/time` (P6): тонкий адаптер над рабочим
 * календарём (пояс, пн–пт, праздники и переносы РК).
 */
export interface DistributionCalendar {
  localDay(at: Ms): LocalDay;
  /** Минут от местной полуночи (0–1439). */
  localMinutes(at: Ms): number;
  isWorkday(day: LocalDay): boolean;
  /** Первый рабочий день строго после `day`. */
  nextWorkday(day: LocalDay): LocalDay;
}

/** «Работает» — получает новые; «Пауза» — сегодня новых не выдавать; «Отсутствует» — не участвует (7.5). */
export type ParticipantStatus = 'working' | 'paused' | 'absent';

export interface Participant {
  userId: UserId;
  status: ParticipantStatus;
  /** «Открытые» у оператора сейчас: новые + перезвоны и повторы, срок которых наступил. */
  open: number;
  /**
   * Из `open` — только новые карточки (без наступивших перезвонов). Для `top_up` (CONFIG 7.1: «K новых»).
   * Не задано — считаем все открытые новыми (осторожнее: выдаём меньше).
   */
  openNew?: number;
  /** Выдано с начала местных суток по видам (из журнала выдач; «вернуть в пул» не вычитается). */
  issuedToday: Readonly<Partial<Record<IssueKind, number>>>;
}

/** Карточка из пула, готовая к раздаче. */
export interface PoolLead {
  id: string;
  /** Оператор, у которого уже есть «двойник» карточки (общий номер, спорная пара) — из БД. */
  heldBy?: UserId | null;
  /** «Двойники» из этого же пула: пара не делится (7.6). Связь симметрична, достаточно указать с одной стороны. */
  twins?: readonly string[];
  /** Есть мобильный номер: мобильные идут раньше городских (`queue.mobileFirst`). По умолчанию — да. */
  hasMobile?: boolean;
  /** Раздавать нельзя до решения РОП (пара с «Не звонить» и т. п.). */
  blocked?: boolean;
}
