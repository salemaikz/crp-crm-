// Типы экрана «Звонить»: настройки для устройства, намерение звонка, запись outbox. Только типы и
// константы: файл безопасен и для браузера, и для тестов. Контракт API — src/server/domain/calls/types.ts.
import type { OutcomeRequest } from '@/server/domain/calls';

export type { OutcomeRequest, OutcomeResponse, QueueCard, QueueCounts, QueuePhone, QueueResponse, SkipResponse, TodaySummary } from '@/server/domain/calls';

export type OutcomeKind = 'no_answer' | 'bad_number' | 'callback' | 'agreed' | 'not_interested' | 'not_target' | 'do_not_call';

/** Виды итога, которые считаются дозвоном (PROCESS 1; зеркало ядра, нужно только для счётчика на устройстве). */
export const CONNECTED_KINDS: readonly OutcomeKind[] = ['callback', 'agreed', 'not_interested', 'not_target', 'do_not_call'];

export interface ReasonOption {
  key: string;
  label: string;
  /** «Другое»: причина требует текста (идёт в заметку). */
  needsText: boolean;
}

export interface OutcomeButton {
  key: string;
  kind: OutcomeKind;
  label: string;
  color: string;
  requires: { lpr: boolean; reason: boolean; callbackAt: boolean; contact: boolean; agreement: boolean; fields: string[] };
  reasons: ReasonOption[];
}

/** Быстрый срок перезвона из настроек (`calling.callbackPresets`); `nextEvent` на устройстве не считается. */
export type CallbackPreset =
  | { kind: 'plus'; minutes: number }
  | { kind: 'nextWorkday'; time: string };

export interface CallCalendar {
  /** ISO-дни недели рабочих дней (1 = понедельник). */
  workdays: number[];
  holidays: Array<{ date: string; kind: 'holiday' | 'workday' }>;
}

/** Поле клиента для строки карточки: подпись и подписи вариантов. */
export interface CardFieldLabel {
  key: string;
  label: string;
  options: Record<string, string>;
}

/** Поле, которое итог просит заполнить в шторке (`requires.fields[]`). */
export interface OutcomeField {
  key: string;
  label: string;
  type: 'text' | 'select';
  options: Array<{ key: string; label: string }>;
}

/** Всё, что экрану нужно из настроек. Приходит с сервера один раз при открытии страницы; ПДн здесь нет. */
export interface CallConfig {
  userId: string;
  outcomes: OutcomeButton[];
  /** Окно отмены итога, мс (`calling.undoSeconds`). */
  undoMs: number;
  lprNoRequiresInfo: boolean;
  lprRequiredOnContact: boolean;
  /** Поля шторки по ключам из `requires.fields[]` итогов. */
  outcomeFields: Record<string, OutcomeField>;
  callbackPresets: CallbackPreset[];
  /** Мягкая цель «звонков в час»; null — не показываем. */
  callsPerHourTarget: number | null;
  timeZone: string;
  calendar: CallCalendar;
  cardFields: CardFieldLabel[];
}

/** Номер в памяти устройства: без цифр, только подпись. */
export interface PendingPhone {
  id: string;
  masked: string;
}

/** «Намерение звонка» (ARCHITECTURE §7): хранится на устройстве, пока не поставлен итог. */
export interface PendingCall {
  opId: string;
  cardId: string;
  clientId: string;
  tappedAt: number;
  title: string;
  phoneId: string | null;
  phoneMasked: string;
  phones: PendingPhone[];
}

/** Черновик шторки: что оператор уже отметил (сохраняется, чтобы шторка пережила перезапуск). */
export interface SheetDraft {
  open: boolean;
  lpr: '' | 'yes' | 'no';
  target: boolean;
  outcomeKey: string;
  reasonCode: string;
  note: string;
  callbackAt: number | null;
  lprName: string;
  lprPhone: string;
  lprWhen: string;
  phoneId: string | null;
  alsoDncPhoneIds: string[];
}

export const EMPTY_DRAFT: SheetDraft = {
  open: false,
  lpr: '',
  target: false,
  outcomeKey: '',
  reasonCode: '',
  note: '',
  callbackAt: null,
  lprName: '',
  lprPhone: '',
  lprWhen: '',
  phoneId: null,
  alsoDncPhoneIds: [],
};

/** Запись outbox: итог ждёт на устройстве. */
export interface OutboxEntry {
  opId: string;
  userId: string;
  request: OutcomeRequest;
  /** Не отправлять раньше (окно отмены). */
  notBefore: number;
  attempts: number;
  /** Не пытаться раньше (повтор после ошибки). */
  retryAt: number;
  createdAt: number;
  /** Подпись для сообщений («итог не принят»): название компании. */
  title: string;
  kind: OutcomeKind;
}

/** Итог, который сервер не принял: показываем оператору и убираем из outbox. */
export interface RejectedEntry {
  opId: string;
  userId: string;
  title: string;
  /** Код ошибки сервера (`not_found`, `lpr_required` …). */
  code: string;
  at: number;
}

export const OUTBOX_RETRY_BASE_MS = 3_000;
export const OUTBOX_RETRY_MAX_MS = 60_000;
/** Периодическая отправка: на iOS нет Background Sync (ARCHITECTURE §7). */
export const OUTBOX_TICK_MS = 15_000;
/** Пинг статуса устройства раз в 5 минут, пока приложение открыто (D-063). */
export const DEVICE_PING_MS = 5 * 60_000;
