// Пул раздачи: кандидаты с двойниками, владельцем двойника и блокировкой пары (D-174), страница пула для РОП.
import { distribution } from '@crm/core';
import { BadRequestError, type Viewer } from '@/server/access';
import type { Permission } from '@/server/access/types';
import { getDb, type Sql } from '@/server/platform/db';
import { distributionDeps } from './deps';
import { requireRole, requireSpace } from './guards';
import { loadParticipants } from './participants';
import {
  countOwnerless,
  poolCounts,
  selectCardsOfClients,
  selectPairs,
  selectPoolCandidates,
  selectPoolPage,
  selectReadyCardsOfClients,
  type PairRow,
  type PartnerCardRow,
  type PoolRow,
} from './repo';
import type { DistributionActor, GetPool, PoolCandidate, PoolHoldKind, PoolItem, PoolPage, PoolSummary } from './types';

/** Сколько кругов дочитываем двойников за пределом выборки (цепочки пар) — та же глубина, что у импорта (ядро). */
const TWIN_ROUNDS = distribution.TWIN_ROUNDS;
/** Сколько первых готовых карточек пула учитываем в сводке `pair_blocked`. */
const SUMMARY_SAMPLE = 1000;

/**
 * Правило одной строки таблицы D-174 — в ядре (`distribution.pairEffect`): его же применяет импорт «Записей», чтобы
 * пара не делилась ни раздачей, ни загрузкой (PROCESS 7.6).
 */
export function pairEffect(y: PartnerCardRow | undefined, status: PairRow['status']): distribution.PairEffect {
  return distribution.pairEffect(y, status);
}

/**
 * Превратить строки пула в кандидатов ядра: дочитать двойников из пула за пределом выборки, найти владельца
 * двойника и заблокировать пару с «Не звонить» (§4). Порядок: исходные строки, затем добавленные двойники.
 */
export async function classifyCandidates(sql: Sql, spaceId: string, rows: readonly PoolRow[]): Promise<PoolCandidate[]> {
  const all = new Map<string, PoolRow>(rows.map((r) => [r.id, r]));
  const byClient = new Map<string, PoolRow>(rows.map((r) => [r.clientId, r]));
  const pairs = new Map<string, PairRow>();
  const seenClients = new Set<string>();
  let frontier: readonly PoolRow[] = rows;
  for (let round = 0; round < TWIN_ROUNDS && frontier.length > 0; round++) {
    const clients = frontier.map((r) => r.clientId).filter((c) => !seenClients.has(c));
    clients.forEach((c) => seenClients.add(c));
    const found = await selectPairs(sql, clients);
    const partners = new Set<string>();
    for (const p of found) {
      pairs.set(`${p.aClientId}|${p.bClientId}|${p.status}`, p);
      for (const c of [p.aClientId, p.bClientId]) if (!byClient.has(c)) partners.add(c);
    }
    const twins = await selectReadyCardsOfClients(sql, { spaceId, clientIds: [...partners] });
    for (const t of twins) {
      if (all.has(t.id)) continue;
      all.set(t.id, t);
      byClient.set(t.clientId, t);
    }
    frontier = twins.filter((t) => !seenClients.has(t.clientId));
  }
  const partnerClients = new Set<string>();
  for (const p of pairs.values()) {
    partnerClients.add(p.aClientId);
    partnerClients.add(p.bClientId);
  }
  const cards = await selectCardsOfClients(sql, { spaceId, clientIds: [...partnerClients] });
  const cardOfClient = new Map(cards.map((c) => [c.clientId, c]));

  const out: PoolCandidate[] = [];
  for (const row of all.values()) {
    const twins = new Set<string>();
    const holders: string[] = [];
    let blocked = false;
    for (const p of pairs.values()) {
      const other = p.aClientId === row.clientId ? p.bClientId : p.bClientId === row.clientId ? p.aClientId : null;
      if (other === null) continue;
      const effect = pairEffect(cardOfClient.get(other), p.status);
      if (effect === 'twin') {
        const twin = byClient.get(other);
        if (twin) twins.add(twin.id);
      } else if (effect === 'blocked') blocked = true;
      else if (effect) holders.push(effect.heldBy);
    }
    holders.sort();
    out.push({
      id: row.id,
      clientId: row.clientId,
      version: row.version,
      hasMobile: row.hasMobile,
      heldBy: holders[0] ?? null,
      twins: [...twins].sort(),
      blocked,
    });
  }
  return out;
}

/** Первые готовые карточки пула вместе с двойниками (тик и «первые N» ручной выдачи). */
export async function loadCandidates(actor: DistributionActor, sql: Sql, a: { spaceId: string; limit: number; perm: Permission }): Promise<PoolCandidate[]> {
  const rows = await selectPoolCandidates(actor, sql, a);
  return classifyCandidates(sql, a.spaceId, rows);
}

// ---------------------------------------------------------------------------
// Страница пула для РОП
// ---------------------------------------------------------------------------

export function encodeCursor(r: Pick<PoolRow, 'createdAt' | 'id'>): string {
  return Buffer.from(`${r.createdAt}:${r.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null): { createdAt: number; id: string } | null {
  if (cursor === null) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const i = text.indexOf(':');
  const createdAt = Number(text.slice(0, i));
  const id = text.slice(i + 1);
  if (i < 1 || !Number.isSafeInteger(createdAt) || id === '') throw new BadRequestError('cursor');
  return { createdAt, id };
}

const HOLD_KINDS: readonly PoolHoldKind[] = ['hold:dup_pair', 'hold:import_conflict', 'hold:no_working_phone', 'hold:rule', 'pair_blocked'];

export const getPool: GetPool = async (viewer: Viewer, input) => {
  requireRole(viewer, 'pool.read');
  const spaceId = requireSpace(viewer);
  const after = decodeCursor(input.cursor);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const db = await getDb();
  return db.tx(async (tx): Promise<PoolPage> => {
    const counts = await poolCounts(viewer, tx, { spaceId });
    const sample = await selectPoolCandidates(viewer, tx, { spaceId, limit: SUMMARY_SAMPLE, perm: 'pool.read' });
    const sampleCandidates = await classifyCandidates(tx, spaceId, sample);
    const sampleIds = new Set(sample.map((r) => r.id));
    const pairBlocked = sampleCandidates.filter((c) => c.blocked && sampleIds.has(c.id)).length;
    const participants = await loadParticipants(tx, cfg, now);
    const roomToday = participants.filter((p) => p.status === 'working').reduce((sum, p) => sum + p.remaining, 0);
    const ready = Math.max(0, counts.ready - pairBlocked);
    const held = Object.fromEntries(HOLD_KINDS.map((k) => [k, k === 'pair_blocked' ? pairBlocked : (counts.held[k.slice('hold:'.length)] ?? 0)])) as Record<PoolHoldKind, number>;
    const ownerless = await countOwnerless(viewer, tx, { spaceId });
    const summary: PoolSummary = { ready, held, roomToday, overCap: Math.max(0, ready - roomToday), ownerless };

    const page = await selectPoolPage(viewer, tx, { spaceId, limit: input.limit + 1, after });
    const rows = page.slice(0, input.limit);
    const candidates = await classifyCandidates(tx, spaceId, rows);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const items: PoolItem[] = [];
    for (const r of rows) {
      const c = byId.get(r.id);
      if (!c || c.blocked) continue;
      items.push({ cardId: r.id, clientId: r.clientId, name: r.name, createdAt: r.createdAt, hasMobile: r.hasMobile, twinCardIds: [...(c.twins ?? [])], heldByUserId: c.heldBy ?? null });
    }
    const last = rows[rows.length - 1];
    return { summary, items, next: page.length > input.limit && last ? encodeCursor(last) : null };
  });
};

