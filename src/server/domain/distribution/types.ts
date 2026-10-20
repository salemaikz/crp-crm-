// Раздача (C6a): контракт домена. Дизайн — docs/distribution-design.md, решения D-173, D-174.
// Здесь только типы и сигнатуры; тела пишет builder в settings.ts, repo.ts, participants.ts, pool.ts, tick.ts,
// manual.ts, journal.ts, job.ts. Сигнатуры меняются только через architect.
//
// Правила модуля:
// - SQL — только в repo.ts; первый аргумент функции репозитория — actor (Viewer или SystemActor);
// - всё, что меняет пул или расход лимита (тик, ручная выдача, возврат в пул, «Отсутствует», возвраты C6c),
//   идёт в транзакции под pg_advisory_xact_lock(DISTRIBUTION_LOCK_KEY) — одна точка сериализации лимита;
// - карточки пула берутся `FOR UPDATE SKIP LOCKED` в порядке id и обновляются условно
//   (owner_user_id IS NULL AND state = 'new' AND hold_reason = '') — гонка с импортом и приёмом не ждёт и
//   не задваивает выдачу;
// - смена владельца повторяет семантику ядра `calling` для события `assign` (PROCESS 3.5 № 2, D-145):
//   паритет проверяет unit-тест; `touched_in_crm` раздача не ставит.
import type { distribution as core } from '@crm/core';
import type { SystemActor, Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

export type DistributionActor = Viewer | SystemActor;

/**
 * Блокировка раздачи (одно bigint на установку; ключи платформы — src/server/platform/db/locks.ts,
 * значения не пересекаются: …001 миграции, …002 настройки, …003 приём). Перенос в locks.ts — задача
 * платформы (тест уникальности ключей), значение не меняется.
 */
export const DISTRIBUTION_LOCK_KEY = 72_026_102_004;

// ---------------------------------------------------------------------------
// Настройки (CONFIG §6.7, §6.6 `queue.mobileFirst`, календарь §6.1–6.2) — срез пространства
// ---------------------------------------------------------------------------

export interface DistributionConfig {
  spaceId: string;
  timeZone: string;
  settings: core.DistributionSettings;
  /** `distribution.participantRoles`. */
  participantRoles: readonly string[];
  /** `queue.mobileFirst`. */
  mobileFirst: boolean;
  /** Календарь установки в форме ядра раздачи (`distribution.toDistributionCalendar`). */
  calendar: core.DistributionCalendar;
}

export type LoadDistributionConfig = (spaceId: string, now: number) => Promise<DistributionConfig>;

// ---------------------------------------------------------------------------
// Участники
// ---------------------------------------------------------------------------

/** Участник раздачи с данными для экрана РОП (имя сотрудника — не ПДн клиента). */
export interface ParticipantView extends core.Participant {
  name: string;
  /** memberships.in_distribution. Не участвует — тик ему не выдаёт, ручная выдача — можно (status working). */
  inDistribution: boolean;
  /** Израсходовано из лимита сегодня по `capIncludes`. */
  capUsed: number;
  cap: number;
  remaining: number;
  /** «Отсутствует» сегодня: до какого дня (C6b пишет absences, здесь только чтение). */
  absentUntil: string | null;
}

export type ListParticipants = (viewer: Viewer) => Promise<ParticipantView[]>;
/** Включить или выключить участие (memberships.in_distribution). «Пауза» и «Отсутствует» — C6b. */
export type SetParticipation = (viewer: Viewer, input: { userId: string; inDistribution: boolean }) => Promise<ParticipantView>;

// ---------------------------------------------------------------------------
// Пул
// ---------------------------------------------------------------------------

/** Почему карточка пула не раздаётся. `hold:*` — cards.hold_reason; остальное — правила пар (D-174). */
export type PoolHoldKind = 'hold:dup_pair' | 'hold:import_conflict' | 'hold:no_working_phone' | 'hold:rule' | 'pair_blocked';

export interface PoolSummary {
  /** Готовы к раздаче: без владельца, `new`, без задержки и без блокировки пары. */
  ready: number;
  held: Readonly<Record<PoolHoldKind, number>>;
  /** Сколько ещё можно выдать сегодня всем работающим участникам (Σ остатков лимита). */
  roomToday: number;
  /** «Сверх лимита»: max(0, ready − roomToday). */
  overCap: number;
}

export interface PoolItem {
  cardId: string;
  clientId: string;
  /** Название клиента — РОП с `pool.read` (охват space) видит его в списке пула. */
  name: string;
  createdAt: number;
  hasMobile: boolean;
  /** Карточки той же группы двойников в пуле (выдаются вместе). */
  twinCardIds: string[];
  /** Владелец двойника вне пула: выдать можно только ему. */
  heldByUserId: string | null;
}

export interface PoolPage {
  summary: PoolSummary;
  items: PoolItem[];
  /** Курсор следующей страницы (created_at, id); null — конец. */
  next: string | null;
}

export type GetPool = (viewer: Viewer, input: { cursor: string | null; limit: number }) => Promise<PoolPage>;

// ---------------------------------------------------------------------------
// Тик и ручная выдача
// ---------------------------------------------------------------------------

/** Кандидат пула из БД — вход `distribution.planAllocation` (`PoolLead`) плюс то, что нужно записи. */
export interface PoolCandidate extends core.PoolLead {
  clientId: string;
  version: number;
}

export type TickSkip = core.SkipReason | 'already_applied' | 'no_participants' | 'no_room' | 'empty_pool';

export interface TickReport {
  status: 'done' | 'skipped';
  reason?: TickSkip;
  /** Выдано по операторам (userId → число). */
  issued: Readonly<Record<string, number>>;
  /** Сколько карточек сменило владельца (UPDATE … RETURNING). */
  assigned: number;
  heldBack: number;
  blocked: number;
  overCap: number;
  /** Пропущены: заняты чужой транзакцией (SKIP LOCKED) или ушли из пула между чтением и записью. */
  raced: number;
  /** Возвраты «Не интересует» перед пулом — C6c (неделя 2); в C6a всегда 0. */
  returned: number;
}

export interface TickInput {
  spaceId: string;
  /** job_runs.id: run_id в assign_log и ключ сводного уведомления `assign:<runId>:<user>`. */
  runId: string;
  /** Начало слота: по нему проверяется окно расписания (планировщик мог опоздать на секунды). */
  slotAt: number;
  now: number;
}

/** Тик раздачи пространства: одна транзакция под DISTRIBUTION_LOCK_KEY. Повтор того же runId — no-op. */
export type RunTick = (actor: SystemActor, input: TickInput, deps?: DistributionDeps) => Promise<TickReport>;

export type ManualIssueSkip = 'pair_held' | 'pair_blocked' | 'not_in_pool' | 'raced';

export interface ManualIssueInput {
  /** UUID с устройства РОП: run_id в assign_log, повтор возвращает прежний итог. */
  opId: string;
  toUserId: string;
  /** Выбранные карточки (1–100) или `count` первых готовых из пула — ровно одно из двух. */
  cardIds?: readonly string[];
  count?: number;
}

export interface ManualIssueResult {
  /** Выданные карточки, включая доведённых до группы двойников. */
  issued: string[];
  skipped: { cardId: string; reason: ManualIssueSkip }[];
  /** Остаток лимита получателя после выдачи. */
  remaining: number;
  cap: number;
  /** true — повтор того же opId: ничего не делали, вернули записанное. */
  replayed: boolean;
}

/**
 * Ручная выдача РОП («Раздать выбранные»). Ошибки домена: `not_working` (пауза, отсутствует, не участник),
 * `over_cap` (сверх остатка при `capOverride = false`; ничего не выдаётся), `mode_off`.
 */
export type IssueCards = (viewer: Viewer, input: ManualIssueInput, deps?: DistributionDeps) => Promise<ManualIssueResult>;

// ---------------------------------------------------------------------------
// Журнал раздачи (PROCESS 7.9)
// ---------------------------------------------------------------------------

export type AssignLogKind = 'auto' | 'manual' | 'return' | 'absence' | 'release' | 'transfer' | 'inbound' | 'proposal' | 'merge' | 'import';

/** Строка журнала: выдачи одного прогона или действия, сгруппированные по виду и получателю. */
export interface JournalRow {
  day: string;
  /** Первое время в группе. */
  at: number;
  kind: AssignLogKind;
  runId: string | null;
  fromUserId: string | null;
  fromName: string | null;
  toUserId: string | null;
  toName: string | null;
  actorId: string | null;
  count: number;
  /** Из них в лимит. */
  countsToCap: number;
}

export type GetJournal = (viewer: Viewer, input: { from: string; to: string; userId?: string }) => Promise<JournalRow[]>;

// ---------------------------------------------------------------------------
// Ошибки домена и зависимости
// ---------------------------------------------------------------------------

export const DISTRIBUTION_ERRORS = ['not_working', 'over_cap', 'mode_off', 'invalid_settings', 'not_participant'] as const;
export type DistributionErrorCode = (typeof DISTRIBUTION_ERRORS)[number];

export interface DistributionFailure {
  code: DistributionErrorCode;
  /** Для `over_cap`: «осталось N из M» (PROCESS 7.3). */
  remaining?: number;
  cap?: number;
}

export interface DistributionDeps {
  config: LoadDistributionConfig;
  now: () => number;
}

/** Записать выдачу пакетом (repo.ts): условный UPDATE + assign_log + лента + сводные уведомления. */
export interface AssignBatch {
  spaceId: string;
  runId: string;
  kind: Extract<AssignLogKind, 'auto' | 'manual'>;
  /** userId → id карточек по порядку. */
  byOperator: Readonly<Record<string, readonly string[]>>;
  countsToCap: boolean;
  /** Местные сутки установки (assign_log.day). */
  day: string;
  actorId: string | null;
  now: number;
}

/** Что реально выдано (карточки, оставшиеся в пуле на момент записи и не занятые чужой транзакцией). */
export interface AssignWritten {
  byOperator: Record<string, string[]>;
  raced: string[];
}

export type WriteAssignBatch = (tx: Sql, actor: DistributionActor, batch: AssignBatch) => Promise<AssignWritten>;
