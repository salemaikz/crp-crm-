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

/** Слой «нейтральные», тёмная тема: серо-графитовая палитра продукта; фон и поверхность клиент переопределяет theme.dark. */
export const NEUTRALS_DARK = {
  canvas: '#121316',
  surface: '#1b1d21',
  text: '#f1f2f4',
  text2: '#c0c4cb',
  text3: '#a2a7b0',
  border: '#33363d',
  /** Рамка полей: не менее 3:1 к поверхности (WCAG 1.4.11). */
  borderStrong: '#7d828c',
} as const;

/** Тёмная тема: оверлей и тени. Тень на тёмном фоне почти не видна, поэтому плотнее. */
export const OVERLAY = { light: 'rgb(20 22 27 / 48%)', dark: 'rgb(0 0 0 / 64%)' } as const;
export const SHADOW_FLOAT = { light: '0 12px 40px rgb(20 22 27 / 22%)', dark: '0 12px 40px rgb(0 0 0 / 60%)' } as const;

export type StateKey = 'success' | 'warning' | 'info' | 'danger';

/** Слой «состояния»: ink — цвет текста и значка на tint и на поверхности (≥ 4.5:1 на обоих). */
export const STATES: Record<StateKey, { ink: string; tint: string }> = {
  success: { ink: '#15753a', tint: '#e6f4ec' },
  warning: { ink: '#8f4c00', tint: '#fdf0dc' },
  info: { ink: '#1f5fbf', tint: '#e7effb' },
  danger: { ink: '#b3151b', tint: '#fdeceb' },
};

/** Состояния для тёмного фона: светлый ink (≥ 4.5:1 на поверхности, подложке и фоне), тёмная подложка. */
export const STATES_DARK: Record<StateKey, { ink: string; tint: string }> = {
  success: { ink: '#4cc47a', tint: '#12301f' },
  warning: { ink: '#f0b04a', tint: '#33260f' },
  info: { ink: '#6aa5f5', tint: '#14284a' },
  danger: { ink: '#ff7b7f', tint: '#3a1618' },
};

/**
 * Чистые цвета тонов для заливки плитки доски (ui-polish §9.4): основа — насыщенный тон, а не тёмный `ink` для текста,
 * иначе жёлтая плитка выглядит бежевой. Заливка = смесь этого цвета с поверхностью установки.
 */
export const TONE_HUE: Record<StateKey, string> = {
  success: '#2fa35a',
  warning: '#f2b200',
  info: '#3b82f6',
  danger: '#e5484d',
};

/** Доля чистого тона в заливке плитки: светлая и тёмная тема. */
export const TONE_ALPHA = { light: 0.3, dark: 0.26 } as const;

/**
 * Тёмная тема: жёлтому нужна большая доля, иначе заливка оливково-коричневая. Выше этого значения не поднять: светлый
 * text-2 перестаёт держать 4.5 на более яркой заливке (deriveToneTile двигает долю к ближайшей проходящей).
 */
export const TONE_ALPHA_DARK_BY_TONE: Partial<Record<StateKey, number>> = { warning: 0.34 };

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
