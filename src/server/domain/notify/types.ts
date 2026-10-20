// Уведомления (P8a): колокол, утренняя сводка, тревоги РОП. Дизайн — PROCESS §11, ARCHITECTURE §6.2, worker-design §6.
// Правила модуля:
// - SQL — только в repo.ts; адресат видит только свои строки (user_id берётся из Viewer, а не из запроса);
// - `params` — только коды, числа и id (без ПДн): текст строит интерфейс из messages/ru/notify.json по `kind`;
// - идемпотентность по `dedupe_key`: сводка — `digest:<user>:<день>`, тревога — `alarm:<вид>:<user>:<день>`;
// - push (P8b) читает те же строки; здесь push не создаётся.
import type { time } from '@crm/core';

/** Виды уведомлений этого модуля. Другие модули пишут свои `kind`; интерфейс показывает неизвестный нейтрально. */
export const NOTIFY_KINDS = [
  'digest_operator',
  'digest_manager',
  'alarm_callbacks_overdue',
  'alarm_handoff_unaccepted',
  'alarm_grey_unassigned',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Числа в params по видам (ключи совпадают с аргументами ICU в messages). */
export interface NotifyParams {
  digest_operator: { callbacks: number; bookings: number };
  digest_manager: { overdue: number; pool: number };
  alarm_callbacks_overdue: { count: number; operators: number };
  alarm_handoff_unaccepted: { count: number };
  alarm_grey_unassigned: { count: number };
}

/** Строка колокола для интерфейса. */
export interface NotificationView {
  id: string;
  kind: string;
  params: Record<string, number | string>;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationPage {
  items: NotificationView[];
  unread: number;
  /** Курсор следующей страницы (created_at строки, строго раньше) или null. */
  next: string | null;
}

/** Срез настроек пространства: кому что слать и пороги. */
export interface NotifyConfig {
  spaceId: string;
  /** Роли РОП-уровня (разрешение `pool.read`): получают сводку пула и тревоги. */
  managerRoles: readonly string[];
  /** Роли операторов (разрешение `card.outcome`, но не `pool.read`): получают утреннюю сводку по своим карточкам. */
  operatorRoles: readonly string[];
  /** `notifications.morningDigestAt`; null — сводка выключена. */
  morningDigestAt: string | null;
  /** `tasks.overdueAlertMinutes`: просрочка перезвона для тревоги. */
  overdueAlertMinutes: number;
}

export type LoadNotifyConfig = (spaceId: string) => Promise<NotifyConfig>;

export interface NotifyDeps {
  config: LoadNotifyConfig;
}

/** Сколько «серая» консультация ждёт консультанта, прежде чем стать тревогой (один шаг сетки автоназначения, PROCESS 5.2). */
export const GREY_WAIT_MIN = 30;

export interface RunInput {
  spaceId: string;
  now: number;
  calendar: Pick<time.WorkCalendar, 'timezone' | 'localDay'>;
}

export interface DigestReport {
  operators: number;
  managers: number;
  /** Сколько уведомлений создано (повтор слота — 0). */
  created: number;
}

export interface AlarmsReport {
  overdueCallbacks: number;
  handoffs: number;
  grey: number;
  /** Создано или обновлено непрочитанных тревог. */
  written: number;
}
