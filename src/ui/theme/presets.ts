// Таблицы темы: нейтральные цвета, состояния, шрифтовые пресеты, форма и плотность.
// Здесь нет значений бренда клиента: они приходят из настроек (theme.*) и пресета клиента.

export const DEFAULT_BRAND = '#2457c5';

/** Слой «нейтральные»: подложка, поверхность, текст, рамки. Светлая тема. */
export const NEUTRALS = {
  canvas: '#f5f6f8',
  surface: '#ffffff',
  text: '#14161b',
  text2: '#4a4f59',
  text3: '#5f646e',
  border: '#dcdfe4',
  /** Рамка полей и значков: не менее 3:1 к поверхности (WCAG 1.4.11). */
  borderStrong: '#8c919a',
} as const;

export type StateKey = 'success' | 'warning' | 'info' | 'danger';

/** Слой «состояния»: ink — цвет текста и значка на tint и на поверхности (≥ 4.5:1 на обоих). */
export const STATES: Record<StateKey, { ink: string; tint: string }> = {
  success: { ink: '#15753a', tint: '#e6f4ec' },
  warning: { ink: '#8f4c00', tint: '#fdf0dc' },
  info: { ink: '#1f5fbf', tint: '#e7effb' },
  danger: { ink: '#b3151b', tint: '#fdeceb' },
};

/** Тон «опасности» для проверки конфликта с цветом бренда. */
export const DANGER_HUE = 358;

export type FontPreset = { body: string; display: string };

const SYSTEM = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * Пресеты шрифтов. Все с кириллицей (в т.ч. cyrillic-ext); веб-шрифты подключает оболочка через
 * next/font и отдаёт CSS-переменные --font-geologica, --font-onest и т.п. Нет переменной — работает запасной стек.
 */
const GEOLOGICA_ONEST: FontPreset = {
  body: `var(--font-onest, ${SYSTEM})`,
  display: `var(--font-geologica, var(--font-onest, ${SYSTEM}))`,
};

export const FONT_PRESETS: Record<string, FontPreset> = {
  system: { body: SYSTEM, display: SYSTEM },
  humanist: {
    body: `var(--font-humanist, ${SYSTEM})`,
    display: `var(--font-humanist, ${SYSTEM})`,
  },
  'geologica-onest': GEOLOGICA_ONEST,
  // Ключ в настройках — `[a-z][a-z0-9_]*` (дефис в нём недопустим), пресет клиента пишет `geologica_onest`
  geologica_onest: GEOLOGICA_ONEST,
};

export const DEFAULT_FONT_PRESET = 'system';

export type RadiusKey = 'sm' | 'md' | 'lg';
export const RADIUS: Record<RadiusKey, { control: number; card: number; sheet: number }> = {
  sm: { control: 6, card: 10, sheet: 14 },
  md: { control: 10, card: 16, sheet: 22 },
  lg: { control: 14, card: 22, sheet: 28 },
};

export type DensityKey = 'compact' | 'normal';

/** Минимальная цель нажатия, px (UX: цели 44px). Плотность её не уменьшает. */
export const TAP_MIN = 44;

export const DENSITY: Record<DensityKey, { control: number; rowY: number; gap: number; card: number; text: number }> = {
  compact: { control: TAP_MIN, rowY: 8, gap: 8, card: 12, text: 15 },
  normal: { control: 48, rowY: 12, gap: 12, card: 16, text: 16 },
};
