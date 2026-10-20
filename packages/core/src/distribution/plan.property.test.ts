// Свойства раздачи: лимит не превышается, выдано ровно min(пул, суммарный остаток).
// Детерминированный генератор с seed, без новых зависимостей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capRemaining } from './cap';
import { planAllocation } from './plan';
import type { DistributionSettings, IssueKind, Participant, ParticipantStatus, PoolLead } from './types';

const CASES = 2500;

/** mulberry32: маленький детерминированный генератор. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

const KINDS: readonly IssueKind[] = ['auto', 'manual', 'return', 'inbound', 'proposal'];

function gen(r: Rng) {
  const settings: Pick<DistributionSettings, 'dailyCap' | 'capIncludes'> = {
    dailyCap: r.int(0, 60),
    capIncludes: KINDS.filter(() => r.chance(0.5)),
  };
  const participants: Participant[] = Array.from({ length: r.int(0, 12) }, (_, i) => ({
    userId: `u-${i}`,
    status: r.pick(['working', 'working', 'working', 'paused', 'absent'] as ParticipantStatus[]),
    open: r.int(0, 80),
    issuedToday: Object.fromEntries(KINDS.filter(() => r.chance(0.4)).map((k) => [k, r.int(0, 40)])),
  }));
  // Пул без двойников, чужих владельцев и блокировок: эти ветки не делят пул по лимиту.
  const pool: PoolLead[] = Array.from({ length: r.int(0, 300) }, (_, i) => ({ id: `c-${i}`, hasMobile: r.chance(0.7) }));
  return { settings, participants, pool };
}

test(`свойство: никто не получает больше остатка лимита, карточки не дублируются (${CASES} случаев)`, () => {
  const r = rng(301);
  for (let i = 0; i < CASES; i++) {
    const { settings, participants, pool } = gen(r);
    const topUpKeep = r.chance(0.4) ? r.int(0, 100) : undefined;
    const plan = planAllocation(participants, pool, settings, { topUpKeep, mobileFirst: r.chance(0.5) });
    const ctx = `случай ${i}: ${JSON.stringify({ settings, topUpKeep, participants, pool: pool.length })}`;
    const seen = new Set<string>();
    for (const p of participants) {
      // Ключ есть у каждого «работающего»; у остальных его может не быть — это то же, что пустой список.
      if (p.status === 'working') assert.ok(plan.byOperator[p.userId], `${ctx}\nнет ключа ${p.userId}`);
      const got = plan.byOperator[p.userId] ?? [];
      const limit = p.status === 'working' ? capRemaining(p, settings) : 0;
      assert.ok(got.length <= limit, `${ctx}\n${p.userId} (${p.status}) получил ${got.length} при остатке ${limit}`);
      if (topUpKeep !== undefined) assert.ok(got.length <= Math.max(0, topUpKeep - p.open) || p.status !== 'working', `${ctx}\ntop_up: ${p.userId} получил ${got.length}`);
      for (const id of got) {
        assert.ok(!seen.has(id), `${ctx}\nкарточка ${id} выдана дважды`);
        seen.add(id);
      }
    }
    // Каждая карточка пула либо выдана, либо в «сверх лимита».
    assert.equal(seen.size + plan.overCap.length + plan.heldBack.length + plan.blocked.length, pool.length, `${ctx}\nкарточки потеряны или задвоены`);
  }
});

test(`свойство: выдано ровно min(пул, суммарный остаток лимитов) (${CASES} случаев)`, () => {
  const r = rng(302);
  for (let i = 0; i < CASES; i++) {
    const { settings, participants, pool } = gen(r);
    const plan = planAllocation(participants, pool, settings);
    const total = Object.values(plan.byOperator).reduce((n, ids) => n + ids.length, 0);
    const remaining = participants.filter((p) => p.status === 'working').reduce((n, p) => n + capRemaining(p, settings), 0);
    assert.equal(total, Math.min(pool.length, remaining), `случай ${i}: ${JSON.stringify({ settings, participants, pool: pool.length })}`);
  }
});

test(`свойство: с heldBy и двойниками лимит не превышается, карточки не теряются (${CASES} случаев)`, () => {
  const r = rng(303);
  for (let i = 0; i < CASES; i++) {
    const { settings, participants } = gen(r);
    const n = r.int(0, 60);
    const pool: PoolLead[] = Array.from({ length: n }, (_, k) => ({
      id: `c-${k}`,
      hasMobile: r.chance(0.7),
      blocked: r.chance(0.05),
      heldBy: r.chance(0.3) ? `u-${r.int(0, 13)}` : null,
      twins: k > 0 && r.chance(0.4) ? [`c-${r.int(0, k - 1)}`] : undefined,
    }));
    const plan = planAllocation(participants, pool, settings, { mobileFirst: r.chance(0.5) });
    const ctx = `случай ${i}: ${JSON.stringify({ settings, participants, pool })}`;
    const seen = new Set<string>();
    for (const p of participants) {
      const got = plan.byOperator[p.userId] ?? [];
      const limit = p.status === 'working' ? capRemaining(p, settings) : 0;
      assert.ok(got.length <= limit, `${ctx}\n${p.userId} получил ${got.length} при остатке ${limit}`);
      for (const id of got) {
        assert.ok(!seen.has(id), `${ctx}\nкарточка ${id} выдана дважды`);
        seen.add(id);
      }
    }
    assert.equal(seen.size + plan.overCap.length + plan.heldBack.length + plan.blocked.length, n, `${ctx}\nкарточки потеряны`);
  }
});
