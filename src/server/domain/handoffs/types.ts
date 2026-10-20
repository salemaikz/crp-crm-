// Передачи в отдел (B6 — создание при покупке, B6b — входящие главы отдела): сигнатуры.
// Дизайн — docs/deals-handoffs-design.md §5.6 и §7, решение D-250. Тела — builder в create.ts, inbox.ts,
// actions.ts, repo.ts. Меняются только через architect.
//
// Правила модуля:
// - строки передач — только через scopeSql(v, 'handoff', perm): глава отдела — отношение `handoff_to_my_team`,
//   исполнитель — `handoff_assigned_to_me`, РОП и директор — охват роли `handoff.read`;
// - статус — токен оптимистичной правки (`UPDATE … WHERE status = $ожидаемый`); идемпотентность — `client_events.id` = opId;
// - текст причины отказа — ПДн (`handoffs.declined_reason`), в ленту и аудит не попадает.
import type { SystemActor, Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import type { DealsSettings } from '@/server/domain/deals/types';

export type HandoffStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface HandoffView {
  id: string;
  status: HandoffStatus;
  teamId: string;
  teamKey: string;
  dealId: string;
  clientId: string;
  clientName: string;
  serviceTypeKey: string;
  wonAt: number | null;
  /** Кто продал (владелец сделки) — имя сотрудника. */
  sellerName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueAt: number;
  /** Срок принятия прошёл, а передача ещё ждёт. */
  overdue: boolean;
  acceptedAt: number | null;
  createdAt: number;
  /** Текст отказа — только РОП и главе отдела, только у `declined`. */
  declinedReason: string | null;
  can: { accept: boolean; decline: boolean; assign: boolean };
}

export interface HandoffListFilter {
  /** По умолчанию `pending` и `accepted`. */
  statuses?: readonly HandoffStatus[];
  limit?: number;
}

export type ListHandoffs = (viewer: Viewer, filter: HandoffListFilter) => Promise<HandoffView[]>;
export type GetHandoff = (viewer: Viewer, handoffId: string) => Promise<HandoffView>;

export interface HandoffActionBase {
  handoffId: string;
  /** UUID действия: повтор возвращает текущее состояние без новых эффектов. */
  opId: string;
}

export type AcceptHandoff = (viewer: Viewer, input: HandoffActionBase) => Promise<HandoffView>;
/** Только из `pending`; причина 1–500 символов. */
export type DeclineHandoff = (viewer: Viewer, input: HandoffActionBase & { reason: string }) => Promise<HandoffView>;
/** Исполнитель — активный сотрудник отдела (`memberships.team_id`); `pending` принимается тем же действием (D-250). */
export type AssignHandoff = (viewer: Viewer, input: HandoffActionBase & { userId: string }) => Promise<HandoffView>;
export type ListHandoffMembers = (viewer: Viewer, handoffId: string) => Promise<{ userId: string; name: string }[]>;

// ---------------------------------------------------------------------------
// Вызовы из модуля сделок (в транзакции покупки и её отмены)
// ---------------------------------------------------------------------------

export interface CreateHandoffInput {
  dealId: string;
  clientId: string;
  spaceId: string;
  /** Владелец карточки — для выбора РОП, если у отдела нет руководителя. */
  ownerUserId: string | null;
  teamKey: string;
  serviceTypeKey: string;
  at: number;
  settings: Pick<DealsSettings, 'calendar' | 'workHoursEnd' | 'acceptSlaWorkdays'>;
}

/**
 * Создать передачу по выигранной сделке: `ON CONFLICT (deal_id) DO NOTHING`, задача руководителю (или РОП, D-250),
 * колокол, лента. null — отдела с таким ключом нет (ошибка настроек: покупка проходит, в лог предупреждение).
 */
export type CreateHandoffForDeal = (tx: Sql, actor: Viewer | SystemActor, input: CreateHandoffInput) => Promise<{ handoffId: string; created: boolean } | null>;

/** Отмена покупки: передача → `cancelled`, задачи передачи закрыты, уведомления отделу. false — передачи не было. */
export type CancelHandoffOfDeal = (tx: Sql, actor: Viewer | SystemActor, input: { dealId: string; at: number }) => Promise<boolean>;

/** Ключи задач передачи (`tasks.source = 'handoff'`). */
export const HANDOFF_TASK_KEYS = {
  accept: (handoffId: string) => `handoff:${handoffId}`,
  noLead: (handoffId: string) => `handoff_nolead:${handoffId}`,
  work: (handoffId: string) => `handoff_work:${handoffId}`,
  declined: (handoffId: string) => `handoff_declined:${handoffId}`,
} as const;

export const HANDOFF_DOMAIN_ERRORS = ['already_handled', 'not_team_member', 'reason_required'] as const;
export type HandoffDomainErrorCode = (typeof HANDOFF_DOMAIN_ERRORS)[number];
