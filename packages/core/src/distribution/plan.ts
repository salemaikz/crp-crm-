// План раздачи (PROCESS 7.1, 7.4–7.6). Чистая функция: ни БД, ни часов.
// Основа: SalemAI 108fb70 src/lib/crm/coldAutoPlan.ts (planEvenDistribution).
// Что изменено против SalemAI:
//  - лимит считается по `capIncludes` (ручная раздача и возвраты входят), а не только по авто;
//  - раздача только в рабочее окно расписания (не ночью) и только в режимах auto_even / top_up;
//  - участники со статусом «Пауза» и «Отсутствует» новых не получают;
//  - мобильные карточки идут раньше городских (`queue.mobileFirst`);
//  - пара не делится и в обе стороны: связь «двойников» симметрична, группа получает одного владельца;
//  - режим top_up (держать не больше K новых).

import { capRemaining } from './cap';
import { isInDistributionWindow } from './schedule';
import type {
  DistributionCalendar,
  DistributionMode,
  DistributionSettings,
  IssueKind,
  Ms,
  Participant,
  PoolLead,
  UserId,
} from './types';

export type HeldReason = 'twin_unavailable' | 'blocked';

export interface AllocationPlan {
  /** userId → id карточек в порядке выдачи. Есть ключ у каждого участника, даже с пустым списком. */
  byOperator: Record<UserId, string[]>;
  /** Пара не делится: владелец двойника не может принять (пауза, нет в раздаче, лимит исчерпан). Ждут РОП («Пул: Дубли»). */
  heldBack: string[];
  /** Карточка заблокирована до решения РОП. */
  blocked: string[];
  /** Ни у кого не осталось места (лимит или «держать K»). Остаются в пуле «Сверх лимита». */
  overCap: string[];
}

export interface AllocationOptions {
  /** top_up: потолок по числу открытых на оператора; `undefined` — режим «поровну». */
  topUpKeep?: number;
  /** `queue.mobileFirst`; по умолчанию включено. */
  mobileFirst?: boolean;
}

const totalIssued = (p: Participant) => Object.values(p.issuedToday).reduce<number>((a, n) => a + Math.max(0, n ?? 0), 0);

/** Группы «двойников» (union-find): id карточки → ключ группы. */
function twinGroups(pool: readonly PoolLead[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    for (;;) {
      const p = parent.get(r);
      if (p === undefined || p === r) break;
      r = p;
    }
    // сжатие пути
    let c = x;
    while (c !== r) {
      const next = parent.get(c) ?? r;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const l of pool) if (!parent.has(l.id)) parent.set(l.id, l.id);
  for (const l of pool) {
    for (const t of l.twins ?? []) {
      if (!parent.has(t)) parent.set(t, t);
      const a = find(l.id);
      const b = find(t);
      if (a !== b) parent.set(a, b);
    }
  }
  return new Map([...parent.keys()].map((id) => [id, find(id)]));
}

/**
 * Разложить пул по операторам. Правила:
 *  - карточка идёт тому, у кого меньше открытых; при равенстве — у кого меньше выдано сегодня, затем по id;
 *  - не больше остатка лимита (и, для top_up, не больше `topUpKeep − open`);
 *  - у пары один оператор: у кого уже есть двойник (БД) или кому выдан двойник раньше в этом плане;
 *    если ему нельзя — ждёт РОП (`heldBack`).
 * Порядок пула сохраняется; мобильные идут раньше городских (устойчивая перестановка).
 */
export function planAllocation(
  participants: readonly Participant[],
  pool: readonly PoolLead[],
  settings: Pick<DistributionSettings, 'dailyCap' | 'capIncludes'>,
  options: AllocationOptions = {},
): AllocationPlan {
  const keep = options.topUpKeep;
  const eligible = participants.filter((p) => p.status === 'working');
  const ops = eligible.map((p) => {
    const room = Math.min(capRemaining(p, settings), keep === undefined ? Infinity : Math.max(0, keep - p.open));
    return { userId: p.userId, open: p.open, issued: totalIssued(p), room };
  });
  const byUser = new Map(ops.map((o) => [o.userId, o]));
  const byOperator: Record<UserId, string[]> = Object.fromEntries(ops.map((o) => [o.userId, []]));
  const plan: AllocationPlan = { byOperator, heldBack: [], blocked: [], overCap: [] };

  const groups = twinGroups(pool);
  // Владелец, уже известный для группы по БД (heldBy любой карточки группы).
  const groupHolder = new Map<string, UserId>();
  for (const l of pool) {
    const g = groups.get(l.id);
    if (l.heldBy && g && !groupHolder.has(g)) groupHolder.set(g, l.heldBy);
  }
  const groupOwner = new Map<string, UserId>();

  const ordered = options.mobileFirst === false ? [...pool] : [...pool.filter((l) => l.hasMobile !== false), ...pool.filter((l) => l.hasMobile === false)];

  const give = (o: (typeof ops)[number], leadId: string, group: string | undefined) => {
    (byOperator[o.userId] ??= []).push(leadId);
    if (group) groupOwner.set(group, o.userId);
    o.open++;
    o.issued++;
    o.room--;
  };

  for (const lead of ordered) {
    if (lead.blocked) {
      plan.blocked.push(lead.id);
      continue;
    }
    const group = groups.get(lead.id);
    const affinity = lead.heldBy ?? (group ? (groupOwner.get(group) ?? groupHolder.get(group)) : undefined) ?? null;
    if (affinity) {
      const o = byUser.get(affinity);
      if (o && o.room > 0) give(o, lead.id, group);
      else plan.heldBack.push(lead.id);
      continue;
    }
    let best: (typeof ops)[number] | null = null;
    for (const o of ops) {
      if (o.room <= 0) continue;
      if (
        !best ||
        o.open < best.open ||
        (o.open === best.open && o.issued < best.issued) ||
        (o.open === best.open && o.issued === best.issued && o.userId < best.userId)
      ) {
        best = o;
      }
    }
    if (best) give(best, lead.id, group);
    else plan.overCap.push(lead.id);
  }
  return plan;
}

export type SkipReason = 'mode_manual' | 'mode_off' | 'not_workday_or_window';

export interface DistributionInput {
  now: Ms;
  calendar: DistributionCalendar;
  settings: DistributionSettings;
  participants: readonly Participant[];
  pool: readonly PoolLead[];
  mobileFirst?: boolean;
}

export type DistributionPlan =
  | { status: 'skipped'; reason: SkipReason }
  | ({ status: 'planned'; mode: Extract<DistributionMode, 'auto_even' | 'top_up'> } & AllocationPlan);

/** Вид выдачи, который пишет журнал для плана тика. */
export const TICK_ISSUE_KIND: IssueKind = 'auto';

/**
 * План на тик расписания. В режимах manual / off и вне окна раздачи (ночь, выходной, праздник)
 * ничего не раздаёт. Приём новых карточек по API раздачу не запускает: они ждут утреннего тика.
 */
export function planDistribution(input: DistributionInput): DistributionPlan {
  const { settings: s } = input;
  if (s.mode === 'off') return { status: 'skipped', reason: 'mode_off' };
  if (s.mode === 'manual') return { status: 'skipped', reason: 'mode_manual' };
  if (!isInDistributionWindow(input.now, input.calendar, s.schedule)) {
    return { status: 'skipped', reason: 'not_workday_or_window' };
  }
  const plan = planAllocation(input.participants, input.pool, s, {
    topUpKeep: s.mode === 'top_up' ? s.topUpKeep : undefined,
    mobileFirst: input.mobileFirst,
  });
  return { status: 'planned', mode: s.mode, ...plan };
}
