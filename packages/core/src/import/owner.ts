// Владелец строки (PROCESS 2.2, 3.7): колонка «оператор» или карта «диапазон строк → оператор».
// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (parseOperatorRules, resolveRowOwner,
// ruleOverlaps). Диапазоны утверждает РОП в предпросмотре; пересечения не угадываются:
// строка идёт в «Спорные из импорта» (hold `import_conflict`).

import type { OperatorSlot, OwnerBy } from './types';
import { normalizeLabel } from './answer';

/** Таблица правил «Цветовой маркер | Оператор | Диапазон строк»: каждая строка — отдельный слот. */
export function parseOperatorRules(grid: readonly (readonly string[])[], header = { operator: 'оператор', ranges: 'диапазон' }): OperatorSlot[] {
  const slots: OperatorSlot[] = [];
  let inTable = false;
  for (const row of grid) {
    const c0 = String(row[0] ?? '').trim();
    const c1 = String(row[1] ?? '').trim();
    const c2 = String(row[2] ?? '').trim();
    if (!inTable) {
      inTable = c1.toLowerCase() === header.operator && c2.toLowerCase().includes(header.ranges);
      continue;
    }
    if (!c1 || /^итого/i.test(c0)) break;
    const ranges = [...c2.matchAll(/(\d+)\s*[–—-]\s*(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
    if (ranges.length === 0) continue;
    const color = c0.replace(/[^\p{L}\s-]/gu, '').trim();
    slots.push({ label: color ? `${c1} (${color})` : c1, name: c1, color, ranges });
  }
  return slots;
}

export type RowOwner =
  | { kind: 'assigned'; userId: string; slots: string[]; blockNo: number }
  | { kind: 'no_rule' }
  | { kind: 'unmapped'; slots: string[] }
  | { kind: 'conflict'; slots: string[] };

/**
 * Чья строка. Пересечение диапазонов разрешается, только если ВСЕ слоты, покрывающие строку,
 * сопоставлены одной и той же учётке. Иначе — конфликт: строка остаётся без владельца.
 */
export function resolveRowOwner(
  rowNo: number,
  slots: readonly OperatorSlot[],
  slotToUser: Readonly<Record<string, string | undefined>>,
): RowOwner {
  const covering = slots.flatMap((s) => {
    const r = s.ranges.findIndex(([a, b]) => rowNo >= a && rowNo <= b);
    return r >= 0 ? [{ slot: s, blockNo: r + 1 }] : [];
  });
  const first = covering[0];
  if (!first) return { kind: 'no_rule' };
  const labels = covering.map((c) => c.slot.label);
  const users = new Set(covering.map((c) => slotToUser[c.slot.label] || ''));
  if (covering.length > 1 && (users.size > 1 || users.has(''))) return { kind: 'conflict', slots: labels };
  const userId = slotToUser[first.slot.label];
  if (!userId) return { kind: 'unmapped', slots: labels };
  return { kind: 'assigned', userId, slots: labels, blockNo: first.blockNo };
}

/** Пересечения диапазонов в самих правилах — для отчёта ещё до сопоставления с учётками. */
export function ruleOverlaps(slots: readonly OperatorSlot[]): { from: number; to: number; slots: string[] }[] {
  const out: { from: number; to: number; slots: string[] }[] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (!a || !b) continue;
      for (const [a1, b1] of a.ranges) {
        for (const [a2, b2] of b.ranges) {
          const from = Math.max(a1, a2);
          const to = Math.min(b1, b2);
          if (from <= to) out.push({ from, to, slots: [a.label, b.label] });
        }
      }
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

/** Владелец строки по профилю. `ownerMap`: ярлык слота (или значение колонки) → id учётки. */
export function resolveOwner(
  rowNo: number,
  operatorLabel: string | null,
  ownerBy: OwnerBy,
  ownerMap: Readonly<Record<string, string | undefined>>,
): RowOwner {
  if (ownerBy.kind === 'row_ranges') return resolveRowOwner(rowNo, ownerBy.slots, ownerMap);
  const label = operatorLabel?.trim();
  if (!label) return { kind: 'no_rule' };
  const byNorm = Object.entries(ownerMap).find(([k]) => normalizeLabel(k) === normalizeLabel(label));
  const userId = byNorm?.[1];
  return userId ? { kind: 'assigned', userId, slots: [label], blockNo: 1 } : { kind: 'unmapped', slots: [label] };
}
