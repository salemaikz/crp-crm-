// Отчёты (R1a): сводка дня РОП. Контракт ответа — один JSON, его же показывает экран и отдаёт /api/reports/summary.
// Только счётчики, id и имена сотрудников; данных клиентов (названий, номеров) в сводке нет.
import type { Viewer } from '@/server/access';
import type { DistributionConfig } from '@/server/domain/distribution';
import type { ReasonColumn } from './reasons';

export type OperatorStatus = 'working' | 'paused' | 'absent';

/** Строка таблицы операторов за сегодня (местные сутки установки). */
export interface OperatorRow {
  userId: string;
  name: string;
  status: OperatorStatus;
  /** Последний день отсутствия; null — не отсутствует. */
  absentUntil: string | null;
  /** Израсходовано из лимита сегодня / лимит (по `capIncludes`). */
  issued: number;
  cap: number;
  /** Итоги звонков, дозвоны (виды-дозвоны), ЛПР «да» (по карточкам). */
  outcomes: number;
  connects: number;
  lpr: number;
  /** Записи, созданные сегодня: групповые и индивидуальные (консультации). */
  groups: number;
  consults: number;
  skips: number;
  /** Просроченные перезвоны (карточек). */
  overdue: number;
  /** Часы в работе: местные часы, в которых был хотя бы один итог. */
  workedHours: number;
  /** Звонков в час; null — часов нет. */
  callsPerHour: number | null;
  /** Мягко: ниже нормы `reports.callsPerHourTarget`. Без блокировок. */
  belowTarget: boolean;
  /** Не отправлено с устройств (D-063): сумма по устройствам, последняя связь, последний успешный сброс. */
  unsent: number;
  lastSeenAt: number | null;
  lastFlushAt: number | null;
}

export interface BookingDayTile {
  /** Живые записи дня (без резерва). */
  total: number;
  /** Подтвердили (или уже пришли). */
  confirmed: number;
}

export interface SummaryTiles {
  /** Пул без владельца. Нет в ответе без чтения карточек. */
  pool: { ready: number; overCap: number; duplicates: number; disputed: number };
  /** Роздано сегодня и лимит × число операторов, которым сегодня выдают. */
  issued: { issued: number; cap: number; operators: number };
  /** «Серые» консультации: индивидуальные записи без консультанта на сегодня и позже. */
  grey: { waiting: number };
  bookings: { today: BookingDayTile; tomorrow: BookingDayTile };
  /** Просроченные перезвоны: карточек и у скольких операторов. */
  overdue: { cards: number; operators: number };
  /** «Не отправлено с устройств»: итогов и у скольких операторов. */
  unsent: { pending: number; operators: number };
}

export interface Summary {
  generatedAt: number;
  /** Местные сутки сводки. */
  day: string;
  timeZone: string;
  /** Порог просрочки перезвона, минут (`tasks.overdueAlertMinutes`). */
  overdueAlertMinutes: number;
  /** Норма звонков в час (`reports.callsPerHourTarget`); null — не задана. */
  callsPerHourTarget: number | null;
  /** Короткие подписи видов записи из настроек (первый групповой и индивидуальный); пусто — вида нет. */
  eventLabels: { group: string; individual: string };
  /**
   * Доска включена (OP_BOARD): `callbackTab` — ключ колонки роли «перезвон» для ссылок К1. Выключена — null, ссылок нет.
   * `confirm` — сегодня день обзвона «подтвердить явку» (OP_BOARD, CALLBACK_V2 и окно из настроек): сводка ведёт на `f=confirm`.
   */
  board: { on: boolean; callbackTab: string | null; confirm: boolean };
  tiles: SummaryTiles;
  /** Красная плитка: что-то просрочено. */
  alarm: boolean;
  operators: OperatorRow[];
}

/** Настройки сводки: срез раздачи (лимит, календарь, роли участников) плюс отчёты и просрочка. */
export interface ReportsConfig {
  distribution: DistributionConfig;
  overdueAlertMinutes: number;
  callsPerHourTarget: number | null;
}

export interface ReportsDeps {
  config: (spaceId: string, now: number) => Promise<ReportsConfig>;
  now: () => number;
  /** Колонки доски ролей «мусор» и «перезвон» для отчёта «Причины»; без подмены — из активных настроек. */
  reasonColumns?: (spaceId: string) => Promise<ReasonColumn[]>;
  /** Обзвон «подтвердить явку» (`booking.confirmCall`): виды и дни недели; без подмены — из активных настроек. */
  confirmCall?: (spaceId: string) => Promise<ConfirmCallCfg | null>;
}

export interface ConfirmCallCfg {
  eventTypes: readonly string[];
  /** Дни обзвона, ISO 1–7. */
  weekdays: readonly number[];
}

export type GetSummary = (viewer: Viewer) => Promise<Summary>;
