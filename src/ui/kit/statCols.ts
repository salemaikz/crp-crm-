// Сколько плиток StatGrid ставить в ряд (D-319, D-331): ряды без дыр. До `max` плиток — одним рядом; больше —
// делитель числа плиток (6 → 3 + 3, 10 → 5 + 5), а если его нет — колонки, при которых последний ряд заполнен
// хотя бы наполовину (7 → 4 + 3), в крайнем случае две колонки. Узкий экран всё равно сокращает колонки сеткой (минимум ширины плитки в CSS).

export const STAT_COLS_MAX = 5;
const STAT_COLS_MIN = 3;

export function statCols(count: number, max = STAT_COLS_MAX): number {
  if (count <= 1) return 1;
  if (count <= max) return count;
  for (let k = max; k >= STAT_COLS_MIN; k--) if (count % k === 0) return k;
  for (let k = max; k >= STAT_COLS_MIN; k--) if ((count % k) * 2 >= k) return k;
  // ни один из 3…max не даёт полряда (37 плиток): две колонки — остаток не больше одной плитки из двух
  return 2;
}
