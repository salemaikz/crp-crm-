// Карточка обзвона на сервере (C5): снимок для ядра `calling`, запись результата перехода и исполнитель
// эффектов. Через этот модуль карточку меняют итоги (calls), события записи (порт для booking, D-133) и
// позже C6b/B9a. Дизайн — docs/calls-design.md §3–§6, решения D-175…D-177. Здесь только типы и сигнатуры.
//
// Правила модуля:
// - SQL — только в repo.ts; строки карточки — через scopeSql, кроме двух явных путей без охвата:
//   (1) порт записи (карточку уже заблокировал и проверил booking), (2) проверка «был владельцем в момент
//   звонка» для `fact_only` (D-175) — ответ наружу всё равно 404 или fact_only, ничего о чужой карточке;
// - порядок блокировок: карточка → (мероприятие → записи) → задачи и прочее. Карточка блокируется первой;
// - версия: `UPDATE cards … WHERE id = $id AND version = $before` — под блокировкой всегда 1 строка,
//   0 строк = ошибка сборки (исключение, откат);
// - эффекты исполняются строго в порядке массивов `calling.Effects` (ядро уже упорядочило задачи и ленту).
import type { calling, time } from '@crm/core';
import type { SystemActor, Viewer } from '@/server/access';
import type { CardPort } from '@/server/domain/booking/types';
import type { Sql } from '@/server/platform/db';

export type CardActor = Viewer | SystemActor;

/** Разрешения, под которыми карточку блокируют ручные события (`scopeSql` умеет любое, D-251). */
export type CardEventPerm = 'card.outcome' | 'card.edit' | 'card.assign' | 'card.return' | 'card.unblock' | 'client.transfer' | 'client.merge';

// ---------------------------------------------------------------------------
// Настройки обзвона пространства (CONFIG §6.5, §6.6, §6.12, календарь §6.1–6.2)
// ---------------------------------------------------------------------------

/** Группы очереди «Звонить» (`queue.order`, PROCESS 7.4). */
export const QUEUE_GROUPS = ['callbacks', 'retries', 'returns', 'new'] as const;
export type QueueGroup = (typeof QUEUE_GROUPS)[number];

export interface CallingContext {
  spaceId: string;
  /** Ревизия настроек пространства: calls.config_rev. */
  configRev: number;
  settings: calling.CallingSettings;
  /** Календарь установки; структурно подходит и под `calling.WorkCalendar`. */
  calendar: time.WorkCalendar;
  /** Справочник итогов в порядке `order` (для шторки и проверки `requires.fields`). */
  outcomes: readonly OutcomeConfig[];
  queue: { order: readonly QueueGroup[]; mobileFirst: boolean; skipLimit: number };
  /** `tasks.overdueAlertMinutes`: перезвон «просрочен» в счётчике очереди. */
  overdueAlertMinutes: number;
}

/** Итог справочника с тем, что нужно серверу сверх `calling.OutcomeDef`. */
export interface OutcomeConfig extends calling.OutcomeDef {
  /** `requires.fields[]`: ключи полей, которые шторка обязана заполнить (проверяет движок полей K2). */
  requiredFields: readonly string[];
}

/** Срез настроек на момент `now` (последняя совместимая ревизия, D-060). Ошибка схемы — `invalid_settings`. */
export type LoadCallingContext = (spaceId: string, now: number) => Promise<CallingContext>;

// ---------------------------------------------------------------------------
// Снимок и блокировка
// ---------------------------------------------------------------------------

/** Карточка под блокировкой: снимок для ядра + то, чего в снимке нет. */
export interface LockedCardRow {
  spaceId: string;
  snapshot: calling.CardSnapshot;
  /** Цифры номеров по id (для стоп-листа и calls.phone_digits); наружу не уходят. */
  phoneDigits: ReadonlyMap<string, string>;
}

/**
 * `SELECT … FROM cards c WHERE c.id = $id AND scopeSql(viewer, 'card', perm) FOR UPDATE OF c`, затем снимок
 * с номерами (рабочие, основной, стоп-лист по HMAC, общий с другим клиентом, держит ли его другой клиент
 * в `do_not_call`). null — карточки нет или она не видна.
 */
export type LockCardScoped = (tx: Sql, viewer: Viewer, cardId: string, perm: CardEventPerm) => Promise<LockedCardRow | null>;

/** Без охвата: только для путей из шапки файла. null — карточки нет. */
export type LockCardUnscoped = (tx: Sql, actor: CardActor, cardId: string) => Promise<LockedCardRow | null>;

/**
 * Был ли сотрудник владельцем или временным владельцем карточки в момент `at` (D-175): последняя строка
 * assign_log карточки с created_at ≤ at указывает на него (to_user_id). Нет строк — сравнение с текущим
 * владельцем не делается: ответ false.
 */
export type WasOwnerAt = (tx: Sql, input: { cardId: string; userId: string; at: number }) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Запись результата перехода
// ---------------------------------------------------------------------------

/** Поля строки calls, которых нет в `calling.CallRecord`. */
export interface CallExtras {
  /** Заметка оператора и текст причины «Другое» (pii). */
  note: string;
  /** Поля из шторки: `requires.fields[]` итога и данные ЛПР `{ lpr: { name, phone, when } }` (pii). */
  fieldsPatch: Readonly<Record<string, unknown>>;
  tappedAt: number | null;
  durationSec: number | null;
  durationSource: 'none' | 'manual_estimate';
}

export interface PersistInput {
  ctx: CallingContext;
  before: LockedCardRow;
  /** Только применённый или факт; `duplicate` и `rejected` сюда не попадают. */
  result: calling.AppliedResult | calling.FactOnlyResult;
  /** Есть, если переход — звонок (result.call !== null). */
  call?: CallExtras;
  /** Момент записи (receivedAt запроса или `now` события). */
  at: number;
  /** opId ручного действия без звонка: `assign_log.run_id` (идемпотентность выдач, D-173). */
  opId?: string;
}

/**
 * Записать переход в транзакции `tx`: строку calls (`ON CONFLICT (id) DO NOTHING`; 0 строк = гонка с тем же
 * opId → исключение `duplicate_race`, вызывающий откатывает и отвечает повтором), карточку по версии,
 * номера (`isWorking`/`isPrimary` из result.card.phones: сначала снять основной, потом поставить), затем
 * эффекты (`ApplyCardEffects`).
 */
export type PersistTransition = (tx: Sql, actor: CardActor, input: PersistInput) => Promise<void>;

/** Карточка для исполнителя эффектов (после перехода: владелец уже новый). */
export interface EffectCard {
  id: string;
  clientId: string;
  spaceId: string;
  ownerUserId: string | null;
  actingUserId: string | null;
  phoneDigits: ReadonlyMap<string, string>;
  /** opId события: `assign_log.run_id`; нет — новый id. */
  opId?: string;
  /** Владелец и временный владелец ДО перехода: у кого `reassign_open` забирает открытые задачи (D-254). */
  priorOwnerUserId?: string | null;
  priorActingUserId?: string | null;
}

/**
 * Исполнитель `calling.Effects`: задачи — tasks/auto.ts; сделки — deals/effects.applyDealEffects;
 * записи — booking/effects.applyBookingEffects; стоп-лист — HMAC номера (platform/hmac) в stop_list;
 * журнал раздачи; уведомления (INSERT … ON CONFLICT (dedupe_key) DO NOTHING, params без ПДн);
 * лента client_events с actor; аудит; пропуски (`skips`, ON CONFLICT (id) DO NOTHING).
 * Получатель `{ role: 'lead' }` разрешает `ResolveLead` (D-176).
 */
export type ApplyCardEffects = (tx: Sql, actor: CardActor, card: EffectCard, effects: calling.Effects, at: number, ctx: CallingContext) => Promise<void>;

/**
 * Руководитель для `{ role: 'lead' }` (D-176): `teams.lead_user_id` команды владельца карточки, если он
 * активен в пространстве и его роль даёт `task.read` с охватом space/all; иначе первый такой сотрудник
 * пространства по (memberships.created_at, user_id). null — никого нет: задача не создаётся, предупреждение в лог.
 */
export type ResolveLead = (tx: Sql, input: { spaceId: string; ownerUserId: string | null; at: number }) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Порт для записи (booking/types.ts CardPort) и сверки
// ---------------------------------------------------------------------------

/** Порт карточки для booking: снимок по LockedCard.id без повторной блокировки → applyOutcome → PersistTransition. */
export type CreateCardBookingPort = (load: LoadCallingContext) => CardPort;

/** Часть ночной сверки `invariants` (D-066): рабочие карточки без владельца, кроме `new`. Только число. */
export type CountOwnerlessWorkingCards = (actor: SystemActor) => Promise<number>;
