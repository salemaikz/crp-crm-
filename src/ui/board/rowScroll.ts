// Горизонтальная прокрутка ряда колонок на ноутбуке (D-358 п. 1): края, шаг кнопок «‹ ›», затухание у края.
// Чистые функции, чтобы геометрию проверяли юнит-тесты; DOM читает только BoardScreen.

export interface RowMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

/**
 * Размеры ряда для расчёта краёв. Ширина окна — `offsetWidth`, а не `clientWidth`: ряд резервирует место под полосу
 * (`scrollbar-gutter: stable`), и последние пиксели прокрутки лежат в этой полосе — по `clientWidth` «конец» не наступал бы.
 */
export const metricsOf = (el: { scrollLeft: number; offsetWidth: number; scrollWidth: number }): RowMetrics => ({ scrollLeft: el.scrollLeft, clientWidth: el.offsetWidth, scrollWidth: el.scrollWidth });

/** За краем ряда слева и справа есть ещё колонки (допуск 2 px на дробные значения). */
export function rowEdges(m: RowMetrics): { before: boolean; after: boolean } {
  return { before: m.scrollLeft > 2, after: m.scrollLeft + m.clientWidth < m.scrollWidth - 2 };
}

/** Куда прокрутить ряд кнопкой «‹ ›»: на `step` пикселей, не дальше краёв. */
export function rowTarget(dir: -1 | 1, m: RowMetrics, step: number): number {
  const max = Math.max(0, m.scrollWidth - m.clientWidth);
  return Math.min(max, Math.max(0, m.scrollLeft + dir * step));
}

/** Шаг кнопки: колонка с промежутком, но не меньше половины видимой ширины, чтобы ряд двигался заметно. */
export function rowStep(columnWidth: number, gap: number, clientWidth: number): number {
  return Math.max(columnWidth + gap, Math.round(clientWidth / 2));
}

/** Тень (затухание) 24 px у тех краёв, где есть ещё колонки; нет краёв — маски нет. */
export function fadeMask({ before, after }: { before: boolean; after: boolean }, px = 24): string | undefined {
  if (!before && !after) return undefined;
  return `linear-gradient(to right, ${before ? `transparent 0, black ${px}px` : 'black 0'}, ${after ? `black calc(100% - ${px}px), transparent 100%` : 'black 100%'})`;
}
