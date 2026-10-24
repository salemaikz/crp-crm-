// Короткие подписи видов записи из настроек пространства: подставляются в «Записи на {event}» (плитки, колонки).
import { getActiveConfigOrNull } from '@/server/platform/config/active';

export type EventTypeDoc = { key: string; behavior: string; short?: { ru?: string }; label: { ru?: string } };

/** Короткие подписи плиток «Записи»: первый групповой и первый индивидуальный вид из booking.eventTypes. */
export function eventShortLabels(eventTypes: readonly EventTypeDoc[]): { group: string; individual: string } {
  const name = (behavior: string): string => {
    const e = eventTypes.find((x) => x.behavior === behavior);
    return e ? (e.short?.ru ?? e.label.ru ?? e.key) : '';
  };
  return { group: name('group'), individual: name('individual') };
}

/** Подписи пространства из активной ревизии; настроек нет (тесты без пресета) — пустые строки. */
export async function loadEventLabels(spaceId: string): Promise<{ group: string; individual: string }> {
  const active = await getActiveConfigOrNull();
  const space = Object.values(active?.spaces ?? {}).find((s) => s.spaceId === spaceId)?.doc;
  return eventShortLabels((space?.booking.eventTypes ?? []) as readonly EventTypeDoc[]);
}
