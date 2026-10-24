// Перетаскивание плитки на доске (pipeline-v2 §9.2): чистая геометрия для своих хуков useMouseDrag и useTouchDrag,
// без библиотеки перетаскивания (D-352, уточняет D-347). Запасной путь для клавиатуры — «⋯ → Перенести в…».

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

/** Шаг автопрокрутки у краёв отрезка [low, high]: отрицательный — к началу, положительный — к концу, 0 — не нужна. */
function edgeStep(pos: number, low: number, high: number, zone: number, maxStep: number): number {
  if (pos < low + zone) return -Math.ceil((maxStep * Math.min(zone, low + zone - pos)) / zone);
  if (pos > high - zone) return Math.ceil((maxStep * Math.min(zone, pos - (high - zone))) / zone);
  return 0;
}

/** Автопрокрутка по горизонтали у краёв контейнера: отрицательное — влево, положительное — вправо, 0 — не нужна. */
export function edgeScroll(x: number, box: { left: number; right: number }, zone = 72, maxStep = 22): number {
  return edgeStep(x, box.left, box.right, zone, maxStep);
}

/**
 * Автопрокрутка колонки по вертикали у её верхнего и нижнего края: отрицательное — вверх, положительное — вниз.
 * Зона меньше, чем по горизонтали: колонка невысокая, а шапка колонки липкая и занимает верх.
 */
export function edgeScrollY(y: number, box: { top: number; bottom: number }, zone = 64, maxStep = 18): number {
  // Колонка ниже двух зон: зоны не должны перекрываться, иначе шаг зависел бы от порядка проверок
  const z = Math.min(zone, Math.max(0, (box.bottom - box.top) / 2 - 1));
  if (z <= 0) return 0;
  return edgeStep(y, box.top, box.bottom, z, maxStep);
}

// ---------- Касание (телефон, этап В) ----------

/** Долгое нажатие, после которого плитка «поднимается» (pipeline-v2 §9.2), мс. */
export const LONG_PRESS_MS = 350;
/** Сдвиг пальца до срабатывания долгого нажатия, после которого это прокрутка, а не перенос, пикселей. */
export const TOUCH_SLOP = 10;

/** Палец ушёл дальше допуска: жест — прокрутка, таймер долгого нажатия сбрасывается. */
export const scrolledAway = (from: Point, to: Point): boolean => Math.hypot(to.x - from.x, to.y - from.y) > TOUCH_SLOP;

/**
 * Цель под пальцем: сначала вкладки колонок (на телефоне они и есть цели), затем сами колонки (планшет, где колонки в
 * ряд). Нет такой — null.
 */
export function hitTarget(p: Point, tabs: readonly ColumnRect[], columns: readonly ColumnRect[]): string | null {
  return hitColumn(p, tabs) ?? hitColumn(p, columns);
}
