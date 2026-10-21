// Группы «двойников» и их держатели (PROCESS 7.6, D-174, D-330). Одна функция для плана раздачи и для импорта
// «Записей»: пара не делится ни там, ни там, в том числе когда пары идут цепочкой через свободного напарника в пуле.
import type { UserId } from './types';

/** Сколько кругов дочитывают пары свободных напарников по цепочке пул раздачи и импорт «Записей» (одна глубина группы). */
export const TWIN_ROUNDS = 4;

/** Участник графа двойников: свободные напарники в пуле (`twins`) и операторы, держащие его пары (`holders`). */
export interface TwinGroupItem {
  id: string;
  /** Свободные напарники в пуле: связь симметрична, достаточно указать с одной стороны. */
  twins?: readonly string[];
  /** Операторы, которые держат пары участника (`distribution.pairEffect` → `heldBy`). */
  holders?: readonly UserId[];
}

export interface TwinGroupHolders {
  /** id участника → ключ группы. */
  groupOf: Map<string, string>;
  /** Ключ группы → первый держатель в порядке участников (раздача отдаёт группу ему). */
  holderOf: Map<string, UserId>;
  /** Группы, которые держат РАЗНЫЕ операторы: делить пару нельзя — ждут РОП. */
  conflict: Set<string>;
}

/** Группы «двойников» (union-find): id → ключ группы. */
export function twinGroups(items: readonly Pick<TwinGroupItem, 'id' | 'twins'>[]): Map<string, string> {
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
  for (const l of items) if (!parent.has(l.id)) parent.set(l.id, l.id);
  for (const l of items) {
    for (const t of l.twins ?? []) {
      if (!parent.has(t)) parent.set(t, t);
      const a = find(l.id);
      const b = find(t);
      if (a !== b) parent.set(a, b);
    }
  }
  return new Map([...parent.keys()].map((id) => [id, find(id)]));
}

/** Группы двойников, держатель каждой группы и группы с разными держателями. */
export function twinGroupHolders(items: readonly TwinGroupItem[]): TwinGroupHolders {
  const groupOf = twinGroups(items);
  const holderOf = new Map<string, UserId>();
  const conflict = new Set<string>();
  for (const l of items) {
    const g = groupOf.get(l.id);
    if (g === undefined) continue;
    for (const h of l.holders ?? []) {
      const prev = holderOf.get(g);
      if (prev === undefined) holderOf.set(g, h);
      else if (prev !== h) conflict.add(g);
    }
  }
  return { groupOf, holderOf, conflict };
}
