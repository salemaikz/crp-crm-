// Передача клиентов (B9a, docs/tasks-team-design.md §6, D-254): одиночная из карточки и массовая от сотрудника.
// Правила состояния — в ядре (`calling` № 22), пакетная запись — transferRepo.ts; здесь порядок: флаг → блокировки →
// проверки → запись → уведомления → аудит. Все ошибки без ПДн: код и детали; «чужое = несуществующее» даёт охват.
import { NotFoundError, type Viewer } from '@/server/access';
import { isRetryableTxError, MAX_TX_ATTEMPTS } from '@/server/domain/booking/tx';
import { loadCallingContext } from '@/server/domain/cards';
import { writeAudit } from '@/server/platform/audit';
import { getDb, type Sql } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import { badRequest, conflict } from './errors';
import { groupFamilies, planEven, TRANSFER_ROWS, type PlanCard } from './plan';
import { loadTransferRoles, requireRecipients } from './recipients';
import type { TransferBulkInput, TransferOneInput, TransferPreviewQuery, TransferTo } from './schemas';
import {
  countRelated,
  countSourceCards,
  insertCountNotifications,
  lockCardsByIds,
  lockSourceCards,
  lockTransfer,
  MAX_BULK_CARDS,
  selectPairsAmong,
  selectPriorTransfer,
  selectRelatedCards,
  selectSourceClients,
  selectSpaceStaff,
  selectTransferCard,
  WORKING_STATES,
  writeMoves,
  type Move,
  type SourceCard,
} from './transferRepo';

type Clock = { now?: () => number };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function spaceOf(viewer: Viewer): string {
  if (viewer.spaceId === null) throw new NotFoundError();
  return viewer.spaceId;
}

/** Массовая передача и мастер отключения — за флагом: выключен = раздела нет (404). */
export function requireBulkFeature(): void {
  if (!isFeatureEnabled('BULK_TRANSFER')) throw new NotFoundError();
}

/** Повтор транзакции при взаимной блокировке: как у остальных ручных действий. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}

export interface TransferOneResult {
  /** Сколько карточек сменило владельца (главная и связанные). */
  moved: number;
  /** Из них связанных двойников. */
  related: number;
  replayed: boolean;
}

const sum = (rows: readonly { n: number }[]): number => rows.reduce((a, r) => a + r.n, 0);

/**
 * Одиночная передача из карточки. Версия главной карточки не совпала — 409 `card_changed`; получатель — активный
 * сотрудник с ролью, ведущей карточки, не текущий владелец. К карточке присоединяются двойники того же владельца
 * в рабочих состояниях (D-038). Снимка нет (D-062): он нужен массовым операциям.
 */
export async function transferOne(viewer: Viewer, input: TransferOneInput, deps?: Clock): Promise<TransferOneResult> {
  const spaceId = spaceOf(viewer);
  const now = deps?.now?.() ?? viewer.now;
  const roles = await loadTransferRoles();
  const ctx = await loadCallingContext(spaceId, now);
  const day = ctx.calendar.localDay(now);
  const db = await getDb();
  return withRetry(() =>
    db.tx(async (tx): Promise<TransferOneResult> => {
      await lockTransfer(tx);
      const prior = await selectPriorTransfer(tx, { spaceId, opId: input.opId });
      if (prior.length > 0) {
        const moved = sum(prior);
        return { moved, related: Math.max(0, moved - 1), replayed: true };
      }
      const [main] = await lockCardsByIds(tx, viewer, { spaceId, ids: [input.cardId] });
      if (!main) throw new NotFoundError();
      if (main.version !== input.version) throw conflict('card_changed');
      if (main.ownerUserId === input.toUserId) throw badRequest('same_owner');
      await requireRecipients(tx, spaceId, [input.toUserId], roles);

      // Двойники: только с тем же владельцем и в рабочем состоянии; блокируем и перепроверяем после блокировки
      let related: SourceCard[] = [];
      if (main.ownerUserId !== null) {
        const candidates = await selectRelatedCards(tx, { spaceId, ownerUserId: main.ownerUserId, seedClientId: main.clientId });
        if (candidates.length > 0) {
          const locked = await lockCardsByIds(tx, viewer, { spaceId, ids: candidates.map((c) => c.id) });
          related = locked.filter((c) => c.ownerUserId === main.ownerUserId && (WORKING_STATES as readonly string[]).includes(c.state));
        }
      }
      const moves: Move[] = [main, ...related].map((c) => ({ cardId: c.id, clientId: c.clientId, fromUserId: c.ownerUserId, actingUserId: c.actingUserId, toUserId: input.toUserId }));
      const written = await writeMoves(tx, { spaceId, opId: input.opId, actorId: viewer.userId, now, day, moves, snapshot: false });
      await insertCountNotifications(tx, {
        kind: TRANSFER_ROWS.notificationKind,
        entityType: '',
        entityId: '',
        counts: new Map([[input.toUserId, written.cards]]),
        dedupe: (to) => `transfer:${input.opId}:${to}`,
        now,
      });
      await writeAudit(tx, {
        actorId: viewer.userId,
        action: 'client.transfer',
        entity: 'client',
        entityId: main.clientId,
        spaceId,
        meta: { count: written.cards, recipients: 1, mode: 'one' },
        createdAt: now,
      });
      return { moved: written.cards, related: written.cards - 1, replayed: false };
    }),
  );
}

export interface TransferPreview {
  /** Карточки по состояниям. */
  cards: Record<string, number>;
  total: number;
  /** Сколько «семей» (двойники не делятся между получателями). */
  families: number;
  tasks: number;
  deals: number;
  bookings: number;
  /** Больше предела операции — применить нельзя, делите по состояниям. */
  tooMany: boolean;
}

/** Предпросмотр массовой передачи (`FEATURE_BULK_TRANSFER`): счётчики по охвату зрителя, ничего не пишет. */
export async function previewBulk(viewer: Viewer, input: TransferPreviewQuery, deps?: Clock): Promise<TransferPreview> {
  requireBulkFeature();
  const spaceId = spaceOf(viewer);
  const now = deps?.now?.() ?? viewer.now;
  const db = await getDb();
  const a = { spaceId, fromUserId: input.from, scope: input.scope };
  const counted = await countSourceCards(db.sql, viewer, { ...a, limit: MAX_BULK_CARDS + 1 });
  const tooMany = counted.total > MAX_BULK_CARDS;
  const related = await countRelated(db.sql, viewer, { ...a, now });
  const cards = await selectSourceClients(db.sql, viewer, { ...a, limit: MAX_BULK_CARDS });
  const families = groupFamilies(cards.map((c): PlanCard => ({ id: c.id, clientId: c.clientId })), await selectPairsAmong(db.sql, cards.map((c) => c.clientId)));
  return { cards: counted.byState, total: counted.total, families: families.length, ...related, tooMany };
}

export interface TransferBulkResult {
  moved: number;
  byRecipient: Record<string, number>;
  replayed: boolean;
}

/** Разложить карточки по получателям: одному или «поровну» (семьи не делятся). */
export async function assignRecipients(tx: Sql, cards: readonly SourceCard[], to: TransferTo): Promise<Move[]> {
  const toMove = (c: SourceCard, toUserId: string): Move => ({ cardId: c.id, clientId: c.clientId, fromUserId: c.ownerUserId, actingUserId: c.actingUserId, toUserId });
  if ('userId' in to) return cards.map((c) => toMove(c, to.userId));
  const pairs = await selectPairsAmong(tx, cards.map((c) => c.clientId));
  const families = groupFamilies(cards.map((c) => ({ id: c.id, clientId: c.clientId })), pairs);
  const plan = planEven(families, to.even);
  return cards.map((c) => toMove(c, plan.toByCard.get(c.id) as string));
}

/** Получатели, названные в запросе. */
export const recipientsOf = (to: TransferTo): string[] => ('userId' in to ? [to.userId] : [...to.even]);

/**
 * Массовая передача (`FEATURE_BULK_TRANSFER`): карточки сотрудника `from` по охвату `working`/`all` одному получателю
 * или поровну, одной транзакцией, со снимками «до» в `change_snapshots` (D-062). Предел — 5 000 карточек (400
 * `too_many`). Повтор `opId` отвечает прежним итогом по журналу раздачи.
 */
export async function transferBulk(viewer: Viewer, input: TransferBulkInput, deps?: Clock): Promise<TransferBulkResult> {
  requireBulkFeature();
  const spaceId = spaceOf(viewer);
  const now = deps?.now?.() ?? viewer.now;
  const recipients = recipientsOf(input.to);
  if (recipients.includes(input.fromUserId)) throw badRequest('same_owner');
  const roles = await loadTransferRoles();
  const ctx = await loadCallingContext(spaceId, now);
  const day = ctx.calendar.localDay(now);
  const db = await getDb();
  return withRetry(() =>
    db.tx(async (tx): Promise<TransferBulkResult> => {
      await lockTransfer(tx);
      const prior = await selectPriorTransfer(tx, { spaceId, opId: input.opId });
      if (prior.length > 0) {
        return { moved: sum(prior), byRecipient: Object.fromEntries(prior.map((r) => [r.toUserId, r.n])), replayed: true };
      }
      await requireRecipients(tx, spaceId, recipients, roles);
      const a = { spaceId, fromUserId: input.fromUserId, scope: input.scope };
      if ((await countSourceCards(tx, viewer, { ...a, limit: MAX_BULK_CARDS + 1 })).total > MAX_BULK_CARDS) throw badRequest('too_many');
      const cards = await lockSourceCards(tx, viewer, { ...a, limit: MAX_BULK_CARDS });
      if (cards.length === 0) return { moved: 0, byRecipient: {}, replayed: false };
      const moves = await assignRecipients(tx, cards, input.to);
      const written = await writeMoves(tx, { spaceId, opId: input.opId, actorId: viewer.userId, now, day, moves, snapshot: true });
      const counts = new Map<string, number>();
      for (const m of moves) counts.set(m.toUserId, (counts.get(m.toUserId) ?? 0) + 1);
      await insertCountNotifications(tx, {
        kind: TRANSFER_ROWS.notificationKind,
        entityType: '',
        entityId: '',
        counts,
        dedupe: (to) => `transfer:${input.opId}:${to}`,
        now,
      });
      await writeAudit(tx, {
        actorId: viewer.userId,
        action: 'client.transfer',
        entity: 'user',
        entityId: input.fromUserId,
        spaceId,
        meta: { count: written.cards, recipients: counts.size, mode: 'userId' in input.to ? 'bulk' : 'bulk_even', scope: input.scope },
        createdAt: now,
      });
      return { moved: written.cards, byRecipient: Object.fromEntries([...counts].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))), replayed: false };
    }),
  );
}

export interface TransferStaffItem {
  userId: string;
  name: string;
  roleKey: string;
  /** Учётка и членство активны: принимать карточки может только активный. */
  active: boolean;
}

export interface TransferStaffList {
  /** Сотрудники пространства, чья роль ведёт карточки (получатели, а также источники массовой передачи). */
  items: TransferStaffItem[];
  /** Связанные двойники карточки `cardId`, которые поедут вместе с ней; без `cardId` — 0. */
  related: number;
}

/** Данные диалогов передачи: кому можно передать и сколько связанных поедет вместе с карточкой. Чужая карточка — 404. */
export async function listTransferStaff(viewer: Viewer, input: { cardId?: string }): Promise<TransferStaffList> {
  const spaceId = spaceOf(viewer);
  const roles = await loadTransferRoles();
  const db = await getDb();
  let related = 0;
  if (input.cardId !== undefined) {
    const main = await selectTransferCard(db.sql, viewer, { spaceId, cardId: input.cardId });
    if (!main) throw new NotFoundError();
    if (main.ownerUserId !== null) related = (await selectRelatedCards(db.sql, { spaceId, ownerUserId: main.ownerUserId, seedClientId: main.clientId })).length;
  }
  const staff = await selectSpaceStaff(db.sql, spaceId);
  return { items: staff.filter((s) => roles.outcome.has(s.roleKey)).map(({ userId, name, roleKey, active }) => ({ userId, name, roleKey, active })), related };
}
