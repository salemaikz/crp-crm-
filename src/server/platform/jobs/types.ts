// Воркер фоновых задач (P7): контракт реестра, расписания и прогона. Дизайн — docs/worker-design.md,
// решения D-171, D-172. Здесь только типы и сигнатуры; тела пишет builder P7 в slot.ts, repo.ts, runner.ts,
// queues.ts (этот каталог) и в src/server/jobs/** (реестр и сборка, там допустим systemActor()).
//
// Правила:
// - расписание — чистая функция `slotFor` от настроек и рабочего календаря установки (один источник правды);
// - один прогон на слот: UNIQUE (job, slot_key) в job_runs + сессионная advisory-блокировка на время прогона;
// - задача модуля описывается объектом `JobDefinition` в своём домене (`src/server/domain/<модуль>/job.ts`)
//   и подключается одной строкой в src/server/jobs/registry.ts;
// - в stats и error — только числа и коды, без ПДн.
import type { time } from '@crm/core';
import type { SystemActor } from '@/server/access';

export type Ms = number;
/** Местное время 'HH:MM'. */
export type HHMM = string;

// ---------------------------------------------------------------------------
// Расписание
// ---------------------------------------------------------------------------

/** Какие дни подходят: все или только рабочие по календарю установки (праздники и переносы учтены). */
export type DayFilter = 'all' | 'workdays';

/**
 * Вид расписания. Ключ слота — местное время пояса установки:
 * - `daily`    — раз в сутки с `at` и до конца суток (догоняет пропуск при простое): ключ 'YYYY-MM-DD';
 * - `times`    — несколько моментов в сутки; слот — последний наступивший момент сегодня: 'YYYY-MM-DDTHH:MM';
 * - `grid`     — сетка `from + k·everyMin ≤ to`; слот — последняя точка сетки, если с неё прошло не больше
 *                `graceMin` (иначе null: пропущенный тик не догоняется, D-171): 'YYYY-MM-DDTHH:MM';
 * - `interval` — каждые `everyMin` минут круглые сутки, от местной полуночи: 'YYYY-MM-DDTHH:MM';
 * - `manual`   — только `crmctl job run` и явный запуск из кода.
 */
export type ScheduleSpec =
  | { kind: 'daily'; at: HHMM; days: DayFilter }
  | { kind: 'times'; at: readonly HHMM[]; days: DayFilter }
  | { kind: 'grid'; from: HHMM; to: HHMM; everyMin: number; days: DayFilter; graceMin: number }
  | { kind: 'interval'; everyMin: number }
  | { kind: 'manual' };

/** Слот прогона: ключ для job_runs.slot_key и момент начала слота (по нему задача проверяет окно). */
export interface Slot {
  key: string;
  /** Начало слота, epoch-мс. Для `manual` и запуска при старте — момент запуска. */
  at: Ms;
}

/** Календарь, нужный расписанию: срез `time.WorkCalendar` установки. */
export type SlotCalendar = Pick<time.WorkCalendar, 'timezone' | 'localDay' | 'isWorkday'>;

/** Чистая функция (slot.ts): слот, в который задача должна работать в момент `now`, или null. */
export type SlotFor = (spec: ScheduleSpec, now: Ms, cal: SlotCalendar) => Slot | null;

/** Документы активных настроек, из которых задача берёт своё расписание. Разбор — схемой самой задачи. */
export interface ScheduleInput {
  /** Документ `global` активной ревизии (пояс, календарь). */
  global: unknown;
  /** Документ пространства для `perSpace`-задач, иначе null. */
  space: unknown | null;
}

// ---------------------------------------------------------------------------
// Задача и её прогон
// ---------------------------------------------------------------------------

/**
 * Что пишет задача — для лицензии «только чтение» (ARCHITECTURE §6.1): `business` (раздача, задачи,
 * уведомления, записи) в read_only/invalid/missing пропускается со статусом skipped; `housekeeping`
 * (чистка, сверки, лицензия) работает всегда.
 */
export type JobWrites = 'business' | 'housekeeping';

/** Логгер прогона: только коды и числа (ПДн в журнал контейнера не пишем). */
export interface JobLogger {
  info(code: string, data?: Readonly<Record<string, number | string | boolean>>): void;
  warn(code: string, data?: Readonly<Record<string, number | string | boolean>>): void;
}

export interface JobSpace {
  id: string;
  key: string;
}

export interface JobContext {
  /** Исполнитель-система с именем экземпляра задачи (`distribute@sales`). */
  readonly actor: SystemActor;
  /** job_runs.id: один на слот, тот же при повторах слота (по нему задача делает свою идемпотентность). */
  readonly runId: string;
  readonly slot: Slot;
  /** Номер попытки в слоте, с 1. */
  readonly attempt: number;
  /** «Сейчас» прогона (часы процесса в момент старта попытки). */
  readonly now: Ms;
  /** Срабатывает по таймауту и при остановке воркера: задача проверяет его между пачками. */
  readonly signal: AbortSignal;
  /** Пространство для `perSpace`-задач, иначе null. */
  readonly space: JobSpace | null;
  readonly calendar: time.WorkCalendar;
  readonly log: JobLogger;
}

/** Итог прогона. stats — только числа (job_runs.stats); note — код причины пропуска. */
export interface JobResult {
  status: 'ok' | 'skipped';
  stats: Readonly<Record<string, number>>;
  note?: string;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

/** Имя задачи: латиница, цифры и дефис (`attendance-sweep`). Экземпляр `perSpace`: `<name>@<spaceKey>`. */
export type JobName = string;

export interface JobDefinition {
  name: JobName;
  /** Экземпляр на каждое пространство из активных настроек: свой слот, своя блокировка, своя строка job_runs. */
  perSpace: boolean;
  /** Расписание из настроек или константа продукта; null — задача сейчас выключена (режим `off`, ключ `null`). */
  schedule(input: ScheduleInput): ScheduleSpec | null;
  /** Дополнительно запустить при старте воркера (слот 'boot:<bootId>'), например `license`. */
  runOnStart?: boolean;
  writes: JobWrites;
  /** Жёсткий предел прогона. По умолчанию 5 минут. */
  timeoutMs?: number;
  /** Попыток в одном слоте, по умолчанию 3 (ARCHITECTURE §6.1). */
  maxAttempts?: number;
  handler: JobHandler;
}

/** Экземпляр задачи на текущих настройках: имя в job_runs (`distribute@sales` или `purge`). */
export interface JobInstance {
  def: JobDefinition;
  runName: string;
  space: JobSpace | null;
  spec: ScheduleSpec | null;
}

/** Строка job_runs глазами воркера и страницы «Состояние». */
export interface JobRunRow {
  id: string;
  job: string;
  slotKey: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  attempt: number;
  startedAt: Ms;
  finishedAt: Ms | null;
  stats: Record<string, number>;
  error: string;
}

/** Решение о попытке в слоте (repo.ts, под блокировкой задачи). */
export type ClaimResult =
  | { kind: 'claimed'; runId: string; attempt: number }
  /** Слот уже закрыт (ok/skipped) или попытки исчерпаны — ничего не делаем. */
  | { kind: 'done' }
  /** Упавший прогон ждёт паузы перед повтором (60 с · 2^(attempt−1)). */
  | { kind: 'backoff'; retryAt: Ms };

/** Сколько ждать повтор упавшей попытки: 60 с, затем 120 с. */
export const JOB_RETRY_BASE_MS = 60_000;
export const JOB_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const JOB_DEFAULT_MAX_ATTEMPTS = 3;
/** После таймаута задаче даётся столько на выход; дальше процесс завершается (контейнер перезапустится). */
export const JOB_HARD_KILL_GRACE_MS = 30_000;

/** Класс (первое int4) сессионных advisory-блокировок задач: pg_try_advisory_lock(JOB_LOCK_CLASS, hashtext(runName)). */
export const JOB_LOCK_CLASS = 72_026_106;

// ---------------------------------------------------------------------------
// Циклы очередей (inbox/outbox) — каждые 5 с, FOR UPDATE SKIP LOCKED
// ---------------------------------------------------------------------------

export type QueueName = 'webhook_inbox' | 'push_outbox';

/** Взятая из очереди строка (аренда `lease_until`), без payload: обработчик читает его сам. */
export interface QueueItem {
  id: string;
  /** `integrations.plugin_id` для вебхука; для push — 'push'. */
  handlerKey: string;
  /** webhook_inbox.kind; для push — ''. */
  kind: string;
  /** Номер попытки, с 1 (attempts после взятия). */
  attempt: number;
}

export type QueueOutcome =
  | { status: 'done' }
  /** Временная ошибка: повтор через min(30 с · 2^(attempt−1), 1 ч); после maxAttempts — failed. */
  | { status: 'retry'; error: string }
  /** Окончательная ошибка (подпись, формат): сразу failed. */
  | { status: 'failed'; error: string };

export type QueueHandler = (actor: SystemActor, item: QueueItem, signal: AbortSignal) => Promise<QueueOutcome>;

export interface QueueSpec {
  name: QueueName;
  /** Сколько строк брать за проход. */
  batch: number;
  leaseMs: number;
  maxAttempts: number;
  /** Обработчики по `handlerKey`; нет обработчика — retry с ошибкой 'no_handler'. */
  handlers: ReadonlyMap<string, QueueHandler>;
  /** Очередь включена (например, push — только при FEATURE_PUSH). */
  enabled(): boolean;
  writes: JobWrites;
}

// ---------------------------------------------------------------------------
// Живость воркера
// ---------------------------------------------------------------------------

/** Строка-пульс: job_runs (job = WORKER_HEARTBEAT_JOB, slot_key = '-'), UPSERT на каждом цикле. */
export const WORKER_HEARTBEAT_JOB = 'worker.heartbeat';
/** Файл живости для healthcheck контейнера: `node dist/worker.mjs --health` → 0, если mtime свежее 90 с. */
export const WORKER_ALIVE_FILE = '/tmp/crm-worker.alive';
export const WORKER_ALIVE_MAX_AGE_MS = 90_000;
export const WORKER_TICK_MS = 30_000;
export const WORKER_QUEUE_TICK_MS = 5_000;

export interface WorkerHeartbeat {
  bootId: string;
  version: string;
  startedAt: Ms;
  lastLoopAt: Ms;
  /** Сколько экземпляров задач в реестре на текущих настройках. */
  jobs: number;
}
