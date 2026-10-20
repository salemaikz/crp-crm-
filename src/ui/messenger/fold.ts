// Сворачивание сообщений ленты по дням (PROCESS 9.1): подряд идущие сообщения одного местного дня — одна строка
// «Переписка: N сообщений» с раскрытием. Чистая функция: без React и сети.
export type FoldableItem = { id: string; kind: string; at: number };

export type Folded<T extends FoldableItem> = { kind: 'item'; item: T } | { kind: 'messages'; key: string; items: T[] };

export const MESSENGER_KINDS: ReadonlySet<string> = new Set(['message', 'messenger.link_opened']);

const dayKey = (at: number, timeZone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

/** Порядок сохраняется (лента идёт от новых к старым); сворачиваются только подряд идущие сообщения одного дня. */
export function foldMessages<T extends FoldableItem>(items: readonly T[], timeZone: string): Folded<T>[] {
  const out: Folded<T>[] = [];
  let run: { day: string; items: T[] } | null = null;
  for (const item of items) {
    if (!MESSENGER_KINDS.has(item.kind)) {
      run = null;
      out.push({ kind: 'item', item });
      continue;
    }
    const day = dayKey(item.at, timeZone);
    if (run && run.day === day) {
      run.items.push(item);
      continue;
    }
    run = { day, items: [item] };
    out.push({ kind: 'messages', key: item.id, items: run.items });
  }
  return out;
}
