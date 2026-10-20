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
  /** userId → id карточек в порядке выдачи (группа двойников — целиком одному оператору, место под неё резервируется при первой выдаче). Ключ есть у каждого участника со статусом «Работает» (даже с пустым списком); на паузе и отсутствующих ключа нет. */
  byOperator: Record<UserId, string[]>;
  /** Пара не делится: владелец двойника не может принять всю группу (пауза, нет в раздаче, мало места). Ждут РОП («Пул: Дубли»). */
  heldBack: string[];
  /** Карточка заблокирована до решения РОП. */
  blocked: string[];
  /** Ни у кого нет места (лимит или «держать K»), в том числе под всю группу двойников. Остаются в пуле «Сверх лимита». */
  overCap: string[];
}

export interface AllocationOptions {
  /** top_up: потолок по числу НОВЫХ у оператора (`Participant.openNew`, иначе `open`); `undefined` — режим «поровну». */
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
 *  - не больше остатка лимита (и, для top_up, не больше `topUpKeep − новые`, CONFIG 7.1);
 *  - у пары один оператор: у кого уже есть двойник (БД) или кому выдан двойник раньше в этом плане;
 *    если ему нельзя — ждёт РОП (`heldBack`);
 *  - группа двойников раздаётся целиком или не раздаётся: места должно хватать на всю группу
 *    сразу (владельцу — `heldBack`, без владельца — `overCap`).
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
    const room = Math.min(capRemaining(p, settings), keep === undefined ? Infinity : Math.max(0, keep - (p.openNew ?? p.open)));
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
  // Члены группы закреплены за РАЗНЫМИ операторами: делить пару нельзя, а резерв места один — вся группа ждёт РОП.
  const groupConflict = new Set<string>();
  {
    const seenHolder = new Map<string, UserId>();
    for (const l of pool) {
      const g = groups.get(l.id);
      if (!g || !l.heldBy) continue;
      const prev = seenHolder.get(g);
      if (prev === undefined) seenHolder.set(g, l.heldBy);
      else if (prev !== l.heldBy) groupConflict.add(g);
    }
  }
  const groupOwner = new Map<string, UserId>();
  // Сколько карточек группы ещё предстоит раздать (заблокированные не считаются) и итог по группе.
  const groupLeft = new Map<string, number>();
  for (const l of pool) {
    const g = groups.get(l.id);
    if (g && !l.blocked) groupLeft.set(g, (groupLeft.get(g) ?? 0) + 1);
  }
  const groupFate = new Map<string, 'heldBack' | 'overCap'>();

  const ordered = options.mobileFirst === false ? [...pool] : [...pool.filter((l) => l.hasMobile !== false), ...pool.filter((l) => l.hasMobile === false)];

  const give = (o: (typeof ops)[number], leadId: string, group: string | undefined) => {
    (byOperator[o.userId] ??= []).push(leadId);
    o.open++;
    o.issued++;
    if (group) {
      // Первая выдача из группы резервирует место под всю группу сразу; остальные карточки группы
      // место уже не тратят, а одиночные карточки не успевают занять резерв.
      const owner = groupOwner.get(group);
      if (owner === undefined) o.room -= groupLeft.get(group) ?? 1;
      else if (owner !== o.userId) o.room--; // не владелец резерва: место берём как под одиночную
      groupLeft.set(group, (groupLeft.get(group) ?? 1) - 1);
      if (owner === undefined) groupOwner.set(group, o.userId);
    } else o.room--;
  };

  for (const lead of ordered) {
    if (lead.blocked) {
      plan.blocked.push(lead.id);
      continue;
    }
    const group = groups.get(lead.id);
    if (group && groupConflict.has(group) && !groupFate.has(group)) groupFate.set(group, 'heldBack');
    const fate = group ? groupFate.get(group) : undefined;
    if (fate) {
      plan[fate].push(lead.id);
      continue;
    }
    // Места нужно столько, сколько карточек группы осталось раздать: целиком или никак.
    const need = (group ? groupLeft.get(group) : undefined) ?? 1;
    const affinity = lead.heldBy ?? (group ? (groupOwner.get(group) ?? groupHolder.get(group)) : undefined) ?? null;
    if (affinity) {
      const o = byUser.get(affinity);
      // Место под группу уже зарезервировано за её владельцем — повторно не проверяем.
      const reserved = group !== undefined && groupOwner.get(group) === affinity;
      if (o && (reserved || o.room >= need)) give(o, lead.id, group);
      else {
        plan.heldBack.push(lead.id);
        if (group) groupFate.set(group, 'heldBack');
      }
      continue;
    }
    let best: (typeof ops)[number] | null = null;
    for (const o of ops) {
      if (o.room < need) continue;
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
    else {
      plan.overCap.push(lead.id);
      if (group) groupFate.set(group, 'overCap');
    }
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
