// Спорные пары (B9b, docs/tasks-team-design.md §7.2, PROCESS 7.6): список РОП и решение «Разные — тому же
// оператору» (`distinct`) или «Выдать другому» (`split_allowed`, с комментарием, если общий номер рабочий у обеих
// сторон). После решения у карточек без других открытых пар снимается задержка «Возможный дубль» (D-272).
// Слияние пары — intake/merge.ts (за FEATURE_MERGE).
import { NotFoundError, type Viewer } from '@/server/access';
import { lockMergeKeys, mergeBadRequest, mergeConflict, releaseDupPairHolds } from '@/server/domain/intake';
import { writeAudit } from '@/server/platform/audit';
import { getDb } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import { requireRole, requireSpace } from './guards';
import { decodeCursor, encodeCursor } from './pool';
import {
  lockPair,
  pairSideVisible,
  resolvePairRow,
  selectPairPhones,
  selectPairSides,
  selectPairsPage,
  sharedWorkingPhone,
  stopListedHmacs,
  type PairReason,
  type PairStatus,
} from './pairsRepo';

/** Сколько пар показывает список за раз (больше — по курсору). */
export const PAIRS_LIMIT = 100;

export interface PairPhoneView {
  /** Цифры номера целиком: РОП видит номера клиентов своего пространства. Номер в «Не звонить» не показывается (null). */
  phone: string | null;
  working: boolean;
  /** Номер есть и у другой стороны пары. */
  shared: boolean;
  /** Номер в «Не звонить»: интерфейс не даёт его набрать. */
  stopListed: boolean;
}

export interface PairSideView {
  clientId: string;
  cardId: string;
  name: string;
  orgId: string;
  state: string;
  ownerUserId: string | null;
  ownerName: string | null;
  lastTouchAt: number | null;
  phones: PairPhoneView[];
}

export interface PairView {
  id: string;
  reason: PairReason;
  status: PairStatus;
  createdAt: number;
  /** Сторона, которой зритель не видит, — null. */
  a: PairSideView | null;
  b: PairSideView | null;
}

export interface PairsPage {
  items: PairView[];
  /** Курсор следующей страницы; null — последняя. */
  next: string | null;
}

export async function listPairs(viewer: Viewer, q: { status?: PairStatus; cursor?: string | null; limit?: number } = {}): Promise<PairsPage> {
  requireRole(viewer, 'pool.read');
  const spaceId = requireSpace(viewer);
  const limit = Math.min(Math.max(1, q.limit ?? PAIRS_LIMIT), PAIRS_LIMIT);
  const after = decodeCursor(q.cursor ?? null);
  const db = await getDb();
  const rows = await selectPairsPage(db.sql, viewer, { spaceId, status: q.status ?? 'open', perm: 'pool.read', after, limit: limit + 1 });
  const pairs = rows.slice(0, limit);
  const last = pairs[pairs.length - 1];
  const next = rows.length > limit && last ? encodeCursor({ createdAt: Number(last.createdAt), id: last.id }) : null;
  const clientIds = [...new Set(pairs.flatMap((p) => [p.aClientId, p.bClientId]))];
  const sides = await selectPairSides(db.sql, viewer, { spaceId, clientIds, perm: 'pool.read' });
  const phones = await selectPairPhones(db.sql, viewer, { clientIds: sides.map((s) => s.clientId), perm: 'pool.read' });
  const stopped = await stopListedHmacs(db.sql, [...new Set(phones.map((p) => phoneHmac(p.digits)))]);
  const sideOf = new Map(sides.map((s) => [s.clientId, s]));
  const digitsOf = (clientId: string) => new Set(phones.filter((p) => p.clientId === clientId).map((p) => p.digits));

  const view = (clientId: string, otherId: string): PairSideView | null => {
    const s = sideOf.get(clientId);
    if (!s) return null;
    const other = digitsOf(otherId);
    return {
      clientId: s.clientId,
      cardId: s.cardId,
      name: s.name,
      orgId: s.orgId,
      state: s.state,
      ownerUserId: s.ownerUserId,
      ownerName: s.ownerName,
      lastTouchAt: s.lastTouchAt === null ? null : Number(s.lastTouchAt),
      phones: phones
        .filter((p) => p.clientId === clientId)
        .map((p) => {
          const stopListed = stopped.has(phoneHmac(p.digits));
          return { phone: stopListed ? null : `+${p.digits}`, working: p.isWorking, shared: other.has(p.digits), stopListed };
        }),
    };
  };

  const items: PairView[] = [];
  for (const p of pairs) {
    const a = view(p.aClientId, p.bClientId);
    const b = view(p.bClientId, p.aClientId);
    // Видимость уже отобрана в SQL; сторона могла исчезнуть между запросами — тогда пару не показываем
    if (!a && !b) continue;
    items.push({ id: p.id, reason: p.reason, status: p.status, createdAt: Number(p.createdAt), a, b });
  }
  return { items, next };
}

export interface ResolvePairInput {
  decision: 'distinct' | 'split_allowed';
  comment: string;
}

export interface ResolvePairResult {
  status: 'distinct' | 'split_allowed';
  /** Сколько карточек вернулось из «Возможный дубль» в «Готовы к раздаче». */
  released: number;
  replayed: boolean;
}

/** Блокировки: приём → раздача (тик читает пары) → строка пары → карточки. Повтор того же решения — прежний итог. */
export async function resolvePair(viewer: Viewer, id: string, input: ResolvePairInput, deps?: { now?: () => number }): Promise<ResolvePairResult> {
  requireRole(viewer, 'card.assign');
  const spaceId = requireSpace(viewer);
  const now = deps?.now?.() ?? viewer.now;
  const comment = input.comment.replace(/\s+/g, ' ').trim();
  const db = await getDb();
  return db.tx(async (tx): Promise<ResolvePairResult> => {
    await lockMergeKeys(tx);
    const pair = await lockPair(tx, id);
    if (!pair || !(await pairSideVisible(tx, viewer, { clientIds: [pair.aClientId, pair.bClientId], perm: 'card.assign' }))) throw new NotFoundError();
    if (pair.status === input.decision) return { status: input.decision, released: 0, replayed: true };
    if (pair.status !== 'open') throw mergeConflict('not_open');
    if (input.decision === 'split_allowed' && comment === '' && (await sharedWorkingPhone(tx, pair))) throw mergeBadRequest('comment_required');
    await resolvePairRow(tx, { id, status: input.decision, comment, by: viewer.userId, now });
    // Видимость пары проверена выше; задержка снимается у обеих сторон, в том числе невидимой решающему (D-272)
    const released = await releaseDupPairHolds(tx, [pair.aClientId, pair.bClientId], now);
    await writeAudit(tx, {
      actorId: viewer.userId,
      action: 'pair.resolve',
      entity: 'pair',
      entityId: id,
      spaceId,
      meta: { decision: input.decision, reason: pair.reason, released, withComment: comment !== '' },
      createdAt: now,
    });
    return { status: input.decision, released, replayed: false };
  });
}
