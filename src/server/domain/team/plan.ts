// Чистая часть передачи (B9a, docs/tasks-team-design.md §6.2–§6.4): семьи двойников и раздача «поровну».
// Без БД и часов: на входе снимки, на выходе решение. Тест — tests/unit/team/planEven.test.ts.

/** Карточка набора передачи: клиент нужен, чтобы собрать семьи по парам-двойникам (D-038). */
export interface PlanCard {
  id: string;
  clientId: string;
}

/** Пара двойников (`dup_pairs` со статусом `open` или `distinct`). */
export interface PlanPair {
  aClientId: string;
  bClientId: string;
}

/** Семья: карточки, которые нельзя разделить между получателями. */
export interface Family {
  /** Наименьший id карточки семьи: стабильный порядок при равенстве размеров. */
  key: string;
  cardIds: readonly string[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Семьи внутри набора: карточки, чьи клиенты связаны парами (транзитивно). Пара с клиентом вне набора ничего не
 * склеивает: семья считается только по тем, кто передаётся. Каждая карточка — ровно в одной семье.
 */
export function groupFamilies(cards: readonly PlanCard[], pairs: readonly PlanPair[]): Family[] {
  const parent = new Map<string, string>(cards.map((c) => [c.clientId, c.clientId]));
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as string;
    return r;
  };
  for (const p of pairs) {
    if (!parent.has(p.aClientId) || !parent.has(p.bClientId)) continue;
    const ra = find(p.aClientId);
    const rb = find(p.bClientId);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const c of cards) {
    const root = find(c.clientId);
    const list = groups.get(root);
    if (list) list.push(c.id);
    else groups.set(root, [c.id]);
  }
  return [...groups.values()].map((ids) => ({ key: [...ids].sort(byText)[0] as string, cardIds: [...ids].sort(byText) })).sort((a, b) => byText(a.key, b.key));
}

export interface EvenPlan {
  /** Получатель каждой карточки. */
  toByCard: Map<string, string>;
  /** Сколько карточек получил каждый (в порядке списка получателей). */
  totals: Map<string, number>;
}

/**
 * «Поровну»: семьи по убыванию размера, затем по наименьшему id; каждая — получателю с наименьшей суммой; при
 * равенстве — тому, кто раньше в списке. Семья не делится. Пустой список получателей — ошибка вызова.
 */
export function planEven(families: readonly Family[], recipients: readonly string[]): EvenPlan {
  if (recipients.length === 0) throw new Error('planEven: нужен хотя бы один получатель');
  const totals = new Map<string, number>(recipients.map((r) => [r, 0]));
  const toByCard = new Map<string, string>();
  const ordered = [...families].sort((a, b) => b.cardIds.length - a.cardIds.length || byText(a.key, b.key));
  for (const f of ordered) {
    let best = recipients[0] as string;
    for (const r of recipients) if ((totals.get(r) as number) < (totals.get(best) as number)) best = r;
    totals.set(best, (totals.get(best) as number) + f.cardIds.length);
    for (const id of f.cardIds) toByCard.set(id, best);
  }
  return { toByCard, totals };
}

/** Строки пакета, одинаковые для любой передачи; тест паритета сверяет их с ядром `calling.applyOutcome({type:'transfer'})`. */
export const TRANSFER_ROWS = {
  assignKind: 'transfer',
  countsToCap: false,
  feedKind: 'card.transferred',
  notificationKind: 'client_transferred',
  versionDelta: 1,
} as const;
