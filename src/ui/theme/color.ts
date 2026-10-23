// Цветовая математика темы: WCAG 2.x контраст, смешение, подбор читаемого текста.
// Чистые функции без зависимостей — их считают и сервер (раздача темы), и тесты.

export type Rgb = readonly [number, number, number];

export const WHITE = '#ffffff';
export const BLACK = '#000000';

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

/** '#abc' / '#aabbcc' → [r, g, b] (0..255); не цвет → null. */
export function parseHex(value: string): Rgb | null {
  if (!isHex(value)) return null;
  let h = value.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((n) => clamp255(n).toString(16).padStart(2, '0')).join('')}`;
}

/** Нормализует hex к виду '#rrggbb' в нижнем регистре. */
export function normalizeHex(value: string): string {
  const rgb = parseHex(value);
  if (!rgb) throw new Error(`Не цвет: ${value}`);
  return toHex(rgb);
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Относительная яркость по WCAG 2.x. */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Не цвет: ${hex}`);
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** Контраст двух цветов, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Порог WCAG AA: 4.5 для обычного текста, 3 — для крупного текста и значков/рамок. */
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

export function meetsAA(fg: string, bg: string, min: number = AA_TEXT): boolean {
  return contrast(fg, bg) >= min;
}

/** Смесь: t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) throw new Error(`Не цвет: ${a} / ${b}`);
  const k = Math.max(0, Math.min(1, t));
  return toHex([ra[0] + (rb[0] - ra[0]) * k, ra[1] + (rb[1] - ra[1]) * k, ra[2] + (rb[2] - ra[2]) * k]);
}

/** Лучший по контрасту текст на фоне bg из кандидатов. Хотя бы один из белого/чёрного даёт ≥ 4.58. */
export function readableOn(bg: string, candidates: readonly string[]): string {
  let best = candidates[0] ?? WHITE;
  let bestRatio = -1;
  for (const c of candidates) {
    const r = contrast(c, bg);
    if (r > bestRatio) {
      best = c;
      bestRatio = r;
    }
  }
  return best;
}

/**
 * Сдвигает fg (по умолчанию к чёрному, на тёмной теме — к белому) минимальными шагами, пока контраст со всеми фонами не достигнет min.
 * Для светлых фонов (поверхность, подложка-тинт) всегда сходится.
 */
export function ensureContrast(fg: string, backgrounds: readonly string[], min: number = AA_TEXT, toward: string = BLACK): string {
  const ok = (c: string) => backgrounds.every((bg) => contrast(c, bg) >= min);
  if (ok(fg)) return normalizeHex(fg);
  for (let i = 1; i <= 100; i++) {
    const c = mix(fg, toward, i / 100);
    if (ok(c)) return c;
  }
  return toward;
}

/** Тон (0..360) цвета; у серых — 0. */
export function hue(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Не цвет: ${hex}`);
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (Math.round(h * 60) + 360) % 360;
}

/** Насыщенность в HSV-смысле (0..1): отличает цветной от серого. */
export function chroma(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Не цвет: ${hex}`);
  return (Math.max(...rgb) - Math.min(...rgb)) / 255;
}

/** Угловое расстояние тонов, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
