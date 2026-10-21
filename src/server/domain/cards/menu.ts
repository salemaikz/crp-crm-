// Действия меню карточки (docs/tasks-team-design.md §5.2, C9): «Вернуть в обзвон», «Снять «Не звонить»»,
// «Не целевой» / «Полный отказ» без звонка. Правила состояния — только в ядре (`calling.applyOutcome`); здесь
// порядок: блокировка с охватом → событие ядра → заметка с комментарием и аудит в той же транзакции.
import type { calling } from '@crm/core';
import { BadRequestError, NotFoundError, type Viewer } from '@/server/access';
import { isRetryableTxError, MAX_TX_ATTEMPTS } from '@/server/domain/booking/tx';
import { insertNote } from '@/server/domain/timeline/repo';
import { writeAudit } from '@/server/platform/audit';
import { getActiveConfig } from '@/server/platform/config/active';
import { getDb, newId, type Sql } from '@/server/platform/db';
import { loadTransferRoles, requireRecipients } from '@/server/domain/team/recipients';
import { CardActionError } from './errors';
import { applyCardEventLocked, runCardEvent } from './manual';
import { lockCardScoped, userActiveInSpace } from './repo';
import { loadCallingContext } from './settings';

export interface ReopenInput {
  opId: string;
  version: number;
  comment: string;
  toUserId?: string | undefined;
}

export interface MenuResult {
  version: number;
  state: string;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Комментарий возврата или снятия «Не звонить» — заметка карточки от имени РОП; ядро текст не хранит. */
async function saveComment(tx: Sql, viewer: Viewer, clientId: string, body: string): Promise<void> {
  await insertNote(tx, viewer, { id: newId(), clientId, dealId: null, body });
}

/**
 * № 14 «Вернуть в обзвон». Владелец пуст или отключён — нужен `toUserId` (400 `owner_required`): сначала
 * `transfer` (версия + 1), затем `reopen` в той же транзакции; иначе карточка вернулась бы к тому, кто её не увидит.
 */
export async function reopenCard(viewer: Viewer, cardId: string, input: ReopenInput): Promise<MenuResult> {
  if (viewer.spaceId === null) throw new NotFoundError();
  const comment = input.comment.trim();
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx(async (tx): Promise<MenuResult> => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        const now = Date.now();
        const row = await lockCardScoped(tx, viewer, cardId, 'card.return');
        if (!row || row.spaceId !== viewer.spaceId) throw new NotFoundError();
        const snap = row.snapshot;
        // Версию и состояние проверяет ядро; здесь только то, чего ядро знать не может: активен ли владелец
        const ownerOk = snap.ownerUserId !== null && (await userActiveInSpace(tx, { spaceId: row.spaceId, userId: snap.ownerUserId }));
        let current = row;
        if (!ownerOk) {
          if (!input.toUserId) throw new BadRequestError('owner_required');
          if (!(await userActiveInSpace(tx, { spaceId: row.spaceId, userId: input.toUserId }))) throw new BadRequestError('user_inactive');
          // Как в обычной передаче: получатель — сотрудник, чья роль ведёт карточки (не директор, не консультант)
          await requireRecipients(tx, row.spaceId, [input.toUserId], await loadTransferRoles());
        }
        const ctx = await loadCallingContext(row.spaceId, now);
        if (!ownerOk && input.toUserId) {
          const moved = await applyCardEventLocked(
            tx, viewer, row, ctx,
            { type: 'transfer', opId: input.opId, toUserId: input.toUserId, seenVersion: input.version, facts: { toUserActive: true } },
            now, { opId: input.opId },
          );
          if (moved.status !== 'applied') throw new CardActionError(moved.status === 'rejected' ? moved.error : 'invalid_transition', null, snap.version);
          current = { ...row, snapshot: moved.card };
        }
        const seen = ownerOk ? input.version : current.snapshot.version;
        const result = await applyCardEventLocked(tx, viewer, current, ctx, { type: 'reopen', opId: input.opId, seenVersion: seen, comment }, now, { opId: input.opId });
        if (result.status === 'rejected') throw new CardActionError(result.error, result.field, snap.version);
        if (result.status !== 'applied') throw new CardActionError('invalid_transition', null, snap.version);
        await saveComment(tx, viewer, snap.clientId, comment);
        await writeAudit(tx, { actorId: viewer.userId, action: 'card.reopen', entity: 'card', entityId: cardId, spaceId: row.spaceId, meta: { cardId, fromState: snap.state }, createdAt: now });
        return { version: result.card.version, state: result.card.state };
      });
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}

export interface ClearDncInput {
  opId: string;
  version: number;
  comment: string;
}

/** № 15 «Снять «Не звонить»»: ядро убирает номера из стоп-листа (кроме удерживаемых другим клиентом) и ставит перезвон. */
export async function clearDnc(viewer: Viewer, cardId: string, input: ClearDncInput): Promise<MenuResult> {
  const comment = input.comment.trim();
  const result = await runCardEvent(
    viewer,
    cardId,
    'card.unblock',
    () => ({ type: 'dnc_clear', opId: input.opId, seenVersion: input.version, comment }),
    {
      opId: input.opId,
      inTx: async (tx, after) => {
        await saveComment(tx, viewer, after.card.clientId, comment);
      },
    },
  );
  return { version: result.card.version, state: result.card.state };
}

export interface CloseInput {
  opId: string;
  version: number;
  kind: 'not_target' | 'do_not_call';
  reasonCode: string;
  alsoDncPhoneIds: string[];
}

export interface ReasonOption {
  key: string;
  label: string;
}

/** Причины вида `kind` из справочника пространства (по группе живого итога этого вида); архивные не предлагаются. */
async function reasonList(viewer: Viewer, kind: calling.OutcomeKind): Promise<ReasonOption[]> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  const doc = space?.doc;
  const group = doc?.calling.outcomes.find((o) => o.kind === kind && !o.archived)?.reasonGroup;
  const list = group ? (doc?.reasons[group] ?? []) : [];
  return list.filter((r) => r.archived !== true).map((r) => ({ key: r.key, label: r.label.ru }));
}

/** Нет справочника причин для вида — принимается любая непустая (ядру причина нужна всегда); есть — только из него. */
async function reasonAllowed(viewer: Viewer, kind: CloseInput['kind'], code: string): Promise<boolean> {
  const list = await reasonList(viewer, kind);
  return list.length === 0 ? code.trim() !== '' : list.some((r) => r.key === code);
}

/** Причины для диалогов закрытия из меню карточки. */
export async function closeReasonOptions(viewer: Viewer): Promise<Record<CloseInput['kind'], ReasonOption[]>> {
  const [notTarget, dnc] = await Promise.all([reasonList(viewer, 'not_target'), reasonList(viewer, 'do_not_call')]);
  return { not_target: notTarget, do_not_call: dnc };
}

/** Подписи причин архива по состоянию карточки: `not_interested`, `not_target`, `do_not_call`, `written_off` (из «Неверный номер»). */
export async function archiveReasonLabels(viewer: Viewer): Promise<Record<string, Record<string, string>>> {
  const kinds: Array<[string, calling.OutcomeKind]> = [
    ['not_interested', 'not_interested'],
    ['not_target', 'not_target'],
    ['do_not_call', 'do_not_call'],
    ['written_off', 'bad_number'],
  ];
  const out: Record<string, Record<string, string>> = {};
  for (const [state, kind] of kinds) out[state] = Object.fromEntries((await reasonList(viewer, kind)).map((r) => [r.key, r.label]));
  return out;
}

/** № 11, 12 из меню: «Не целевой» и «Полный отказ» без звонка; причина обязательна и берётся из справочника. */
export async function closeCard(viewer: Viewer, cardId: string, input: CloseInput): Promise<MenuResult> {
  if (!(await reasonAllowed(viewer, input.kind, input.reasonCode))) throw new BadRequestError('reason_code');
  const result = await runCardEvent(
    viewer,
    cardId,
    'card.outcome',
    () => ({ type: 'close_from_menu', opId: input.opId, seenVersion: input.version, kind: input.kind, reasonCode: input.reasonCode, alsoDncPhoneIds: input.alsoDncPhoneIds }),
    { opId: input.opId },
  );
  return { version: result.card.version, state: result.card.state };
}
