// Перетаскивание плитки мышью на ноутбуке (pipeline-v2 §9.2): чистая геометрия. Библиотека @dnd-kit в проект ещё не
// добавлена (зависимость вносит координатор отдельным коммитом, D-347), поэтому мышь обслуживают события указателя.
// Касание сюда не попадает: на телефоне прокрутка свободна, а перенос идёт через «⋯ → Перенести в…».

/** Сдвиг в пикселях, после которого нажатие становится перетаскиванием (до него это обычный клик по плитке). */
export const DRAG_THRESHOLD = 6;

export interface Point {
  x: number;
  y: number;
}

export interface ColumnRect {
  key: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const movedEnough = (from: Point, to: Point): boolean => Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;

/** Колонка под указателем; нет такой — null. */
export function hitColumn(p: Point, rects: readonly ColumnRect[]): string | null {
  return rects.find((r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom)?.key ?? null;
}

/** Автопрокрутка по горизонтали у краёв контейнера: отрицательное — влево, положительное — вправо, 0 — не нужна. */
export function edgeScroll(x: number, box: { left: number; right: number }, zone = 72, maxStep = 22): number {
  if (x < box.left + zone) return -Math.ceil((maxStep * Math.min(zone, box.left + zone - x)) / zone);
  if (x > box.right - zone) return Math.ceil((maxStep * Math.min(zone, x - (box.right - zone))) / zone);
  return 0;
}
