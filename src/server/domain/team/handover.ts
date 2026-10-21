// Передача дел при отключении сотрудника (B9a, docs/tasks-team-design.md §6.4, D-066, D-255). Выполняется внутри
// транзакции отключения, по каждому пространству, где было членство. Инвариант: после «срочного» режима у
// отключённого нет рабочей карточки (если получатель нашёлся), а нетронутые новые вернулись в пул.
//
// Порядок: получатель → нетронутые `new` в пул → рабочие карточки получателю (со снимком) → замены временного
// владельца → оставшиеся задачи, записи, сделки → отмена отсутствий → уведомления. Закрытые карточки остаются
// за отключённым (архив). Получателя нет — карточки остаются, администратору уходит тревога.
import type { Viewer } from '@/server/access/types';
import { applyCardEventLocked, loadCallingContext } from '@/server/domain/cards';
import { loadSnapshot } from '@/server/domain/cards/repo';
import { NotFoundError } from '@/server/access';
import { getDb, newId, type Sql } from '@/server/platform/db';
import { loadTransferRoles, requireRecipients, urgentRecipient, type TransferRoles } from './recipients';
import { defaultSpaceId } from './repo';
import type { TransferTo } from './schemas';
import { assignRecipients, recipientsOf, requireBulkFeature } from './transfer';
import {
  cancelAbsencesOf,
  countStaffLoad,
  insertCountNotifications,
  lockStaffCards,
  lockTransfer,
  reassignBookingsAndDealsOf,
  reassignOpenTasksOf,
  replaceActing,
  selectMemberSpaces,
  selectSpaceStaff,
  WORKING_STATES,
  writeMoves,
  type Move,
} from './transferRepo';

export type HandoverMode = 'urgent' | 'wizard';

export type HandoverInput = {
  /** Кто отключает (администратор): он же получатель «срочных» дел, если его роль ведёт карточки пространства. */
  actorId: string;
  /** Администратор целиком: аудит и снимки пишутся от его имени. */
  viewer: Viewer;
  userId: string;
  /** Пространство администратора: к нему относится выбор получателя мастера; в остальных идёт «срочно». */
  spaceId: string | null;
  mode: HandoverMode;
  /** Получатель мастера; нет — как «срочно». */
  to?: TransferTo | undefined;
  nowMs: number;
};

export type HandoverSpaceStatus = 'done' | 'no_recipient';

export interface HandoverSpaceResult {
  spaceId: string;
  status: HandoverSpaceStatus;
  /** Получатель «срочных» дел пространства; null — некому принимать. */
  recipientId: string | null;
  /** Рабочие карточки, получившие нового владельца. */
  moved: number;
  /** Нетронутые новые, вернувшиеся в пул. */
  released: number;
  /** Карточки, где он был временным владельцем: временный заменён. */
  actingMoved: number;
  /** Рабочие карточки, оставшиеся за ним (получателя нет). */
  left: number;
  tasks: number;
  bookings: number;
  deals: number;
}

export type HandoverResult = {
  /** `no_recipient`, если хотя бы в одном пространстве принять дела было некому. */
  status: 'done' | 'no_recipient';
  /** Сколько рабочих карточек получило нового владельца (без ПДн, для аудита и тревоги). */
  movedCards: number;
  releasedCards: number;
  actingCards: number;
  spaces: HandoverSpaceResult[];
};

export interface StaffHandover {
  /** Вызывается в транзакции отключения, после закрытия сессий. */
  run(sql: Sql, input: HandoverInput): Promise<HandoverResult>;
}

const isWorking = (state: string): boolean => (WORKING_STATES as readonly string[]).includes(state);

async function handoverSpace(tx: Sql, input: HandoverInput, spaceId: string, roles: TransferRoles, opId: string): Promise<HandoverSpaceResult> {
  const { userId, nowMs: now } = input;
  const out: HandoverSpaceResult = { spaceId, status: 'done', recipientId: null, moved: 0, released: 0, actingMoved: 0, left: 0, tasks: 0, bookings: 0, deals: 0 };
  const ctx = await loadCallingContext(spaceId, now);
  const day = ctx.calendar.localDay(now);
  const recipient = await urgentRecipient(tx, { spaceId, actorId: input.actorId, exceptUserId: userId, roles });
  out.recipientId = recipient;

  const cards = await lockStaffCards(tx, { spaceId, userId });
  const owned = cards.filter((c) => c.ownerUserId === userId);
  const untouched = owned.filter((c) => c.state === 'new' && c.callsTotal === 0 && c.actingUserId === null);
  const untouchedIds = new Set(untouched.map((c) => c.id));
  const working = owned.filter((c) => isWorking(c.state) && !untouchedIds.has(c.id));
  const acting = cards.filter((c) => c.actingUserId === userId && c.ownerUserId !== userId && c.ownerUserId !== null);

  // 2. Нетронутые новые — в пул; лимит не возвращается (ядро: `release`)
  for (const c of untouched) {
    const row = await loadSnapshot(tx, c.id);
    if (!row) continue;
    const r = await applyCardEventLocked(tx, input.viewer, row, ctx, { type: 'release', opId, seenVersion: row.snapshot.version }, now, { opId });
    if (r.status === 'applied') out.released++;
  }

  // Мастер выбирает получателя рабочих карточек; остальное идёт получателю «срочного» режима
  const wizardHere = input.mode === 'wizard' && input.to !== undefined && input.spaceId === spaceId;
  let moves: Move[] = [];
  if (working.length > 0) {
    if (wizardHere && input.to) {
      await requireRecipients(tx, spaceId, recipientsOf(input.to), roles);
      moves = await assignRecipients(tx, working, input.to);
    } else if (recipient !== null) {
      moves = await assignRecipients(tx, working, { userId: recipient });
    }
  }
  // 3. Рабочие карточки — получателям (со снимком)
  if (moves.length > 0) {
    const written = await writeMoves(tx, { spaceId, opId, actorId: input.actorId, now, day, moves, snapshot: true });
    out.moved = written.cards;
    out.tasks += written.tasks;
    out.deals += written.deals;
    out.bookings += written.bookings;
  }
  out.left = working.length - moves.length;

  // 4. Где он временный владелец: временный — получатель (срок прежний); получатель = владелец или некого — временного снимаем
  const replacements = acting.map((c) => {
    const toUserId = recipient !== null && recipient !== c.ownerUserId ? recipient : null;
    return { cardId: c.id, toUserId, fromUserId: userId };
  });
  if (replacements.length > 0) {
    out.actingMoved = await replaceActing(tx, { spaceId, opId, actorId: input.actorId, now, day, items: replacements });
  }

  // 5. Оставшиеся открытые задачи, будущие записи и открытые сделки — получателю
  if (recipient !== null) {
    out.tasks += await reassignOpenTasksOf(tx, { spaceId, fromUserId: userId, toUserId: recipient });
    const rest = await reassignBookingsAndDealsOf(tx, { spaceId, fromUserId: userId, toUserId: recipient, now });
    out.bookings += rest.bookings;
    out.deals += rest.deals;
  }

  // 6. Неотменённые отсутствия
  await cancelAbsencesOf(tx, { spaceId, userId, now });

  // 7. Уведомления: получателю — «вам переданы дела отключённого»; администратору — если принять было некому
  const received = new Map<string, number>();
  for (const m of moves) received.set(m.toUserId, (received.get(m.toUserId) ?? 0) + 1);
  if (recipient !== null && out.actingMoved > 0) received.set(recipient, (received.get(recipient) ?? 0) + out.actingMoved);
  if (received.size > 0) {
    await insertCountNotifications(tx, {
      kind: 'staff_disabled',
      entityType: 'handover',
      entityId: opId,
      counts: received,
      dedupe: (to) => `staff_disabled:${userId}:${spaceId}:${to}`,
      now,
    });
  }
  if (recipient === null) {
    out.status = 'no_recipient';
    await insertCountNotifications(tx, {
      kind: 'staff_disabled_orphans',
      entityType: 'handover',
      entityId: opId,
      counts: new Map([[input.actorId, out.left + acting.length]]),
      dedupe: () => `staff_disabled_orphans:${userId}:${spaceId}`,
      now,
    });
  }
  return out;
}

/** Реализация `StaffHandover` (B9a). */
export const staffHandover: StaffHandover = {
  async run(tx, input) {
    if (input.mode === 'wizard' && input.to !== undefined) requireBulkFeature();
    await lockTransfer(tx);
    const roles = await loadTransferRoles();
    const opId = newId();
    const spaces: HandoverSpaceResult[] = [];
    for (const m of await selectMemberSpaces(tx, input.userId)) spaces.push(await handoverSpace(tx, input, m.spaceId, roles, opId));
    return {
      status: spaces.some((s) => s.status === 'no_recipient') ? 'no_recipient' : 'done',
      movedCards: spaces.reduce((a, s) => a + s.moved, 0),
      releasedCards: spaces.reduce((a, s) => a + s.released, 0),
      actingCards: spaces.reduce((a, s) => a + s.actingMoved, 0),
      spaces,
    };
  },
};

export interface HandoverPreview {
  /** Карточки сотрудника по состояниям (все, включая закрытые: они остаются у него). */
  cards: Record<string, number>;
  /** Рабочие карточки: их получит новый владелец. */
  working: number;
  /** Нетронутые новые: вернутся в пул. */
  untouched: number;
  /** Карточки, где он временный владелец. */
  actingCards: number;
  tasks: number;
  deals: number;
  bookings: number;
  /** Кто примет дела в «срочном» режиме; null — некому (карточки останутся за ним, тревога). */
  recipient: { userId: string } | null;
  /** Кому мастер может передать карточки: активные сотрудники пространства, чья роль ведёт карточки. */
  candidates: Array<{ userId: string; name: string }>;
}

/** Сводка для диалога «Отключить…» (только администратор): что произойдёт, ничего не пишет. */
export async function handoverPreview(viewer: Viewer, userId: string, deps?: { now?: () => number }): Promise<HandoverPreview> {
  const db = await getDb();
  const spaceId = viewer.spaceId ?? (await defaultSpaceId(db.sql));
  if (!spaceId) throw new NotFoundError();
  const now = deps?.now?.() ?? viewer.now;
  const load = await countStaffLoad(db.sql, { spaceId, userId, now });
  const [untouchedRow] = await db.sql<{ n: number }>`
    SELECT count(*)::int AS n FROM cards c WHERE c.space_id = ${spaceId} AND c.owner_user_id = ${userId} AND c.state = 'new' AND c.calls_total = 0 AND c.acting_user_id IS NULL`;
  const untouched = untouchedRow?.n ?? 0;
  const working = Object.entries(load.byState).filter(([s]) => isWorking(s)).reduce((a, [, n]) => a + n, 0) - untouched;
  const roles = await loadTransferRoles();
  const recipient = await urgentRecipient(db.sql, { spaceId, actorId: viewer.userId, exceptUserId: userId, roles });
  const staff = await selectSpaceStaff(db.sql, spaceId);
  const candidates = staff.filter((m) => m.active && m.userId !== userId && roles.outcome.has(m.roleKey)).map((m) => ({ userId: m.userId, name: m.name }));
  return {
    cards: load.byState,
    working,
    untouched,
    actingCards: load.actingCards,
    tasks: load.tasks,
    deals: load.deals,
    bookings: load.bookings,
    recipient: recipient ? { userId: recipient } : null,
    candidates,
  };
}
