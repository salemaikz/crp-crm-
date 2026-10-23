// Тема из настроек: theme.brandColor, accentColor, fontPreset, radius, density, statusStyle →
// набор CSS-переменных трёх слоёв (бренд, нейтральные, состояния). Остальное считается.
// Гарантии: текст на брендовой кнопке и бренд-текст на поверхности — не ниже AA (4.5:1).
import {
  AA_LARGE,
  AA_TEXT,
  BLACK,
  WHITE,
  chroma,
  contrast,
  ensureContrast,
  hue,
  hueDistance,
  isHex,
  mix,
  normalizeHex,
  readableOn,
} from './color';
import type { ThemeMode } from './mode';
import {
  DANGER_HUE,
  DEFAULT_BRAND,
  DEFAULT_FONT_PRESET,
  DENSITY,
  FONT_PRESETS,
  NEUTRALS,
  NEUTRALS_DARK,
  OVERLAY,
  RADIUS,
  SHADOW_FLOAT,
  STATES,
  STATES_DARK,
  TAP_MIN,
  type DensityKey,
  type RadiusKey,
  type StateKey,
} from './presets';

export type StatusStyle = 'color' | 'color_text_icon';

/** Тёмная тема клиента (theme.dark): всё необязательно, недостающее — нейтральная палитра продукта. */
export type DarkSettings = { canvas: string | null; surface: string | null; brandColor: string | null; accentColor: string | null };

export type ThemeSettings = {
  /** Вид по умолчанию, пока сотрудник не выбрал сам; не задан — «как в системе» при включённом флаге. */
  defaultMode: ThemeMode | null;
  dark: DarkSettings;
  brandColor: string;
  accentColor: string | null;
  fontPreset: string;
  radius: RadiusKey;
  density: DensityKey;
  statusStyle: StatusStyle;
};

export type ThemeWarning = 'invalid-setting' | 'unknown-font-preset' | 'brand-near-danger' | 'brand-adjusted' | 'status-color-only' | 'dark-brand-lightened' | 'dark-accent-lightened' | 'dark-surface-invalid';
export type ThemeVariant = 'light' | 'dark';

export type Theme = {
  settings: ThemeSettings;
  /** CSS-переменные: имя с '--' → значение. */
  vars: Record<string, string>;
  warnings: ThemeWarning[];
  /** Какие ключи настроек были неверны (для журнала). */
  invalidKeys: string[];
};

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  defaultMode: null,
  dark: { canvas: null, surface: null, brandColor: null, accentColor: null },
  brandColor: DEFAULT_BRAND,
  accentColor: null,
  fontPreset: DEFAULT_FONT_PRESET,
  radius: 'md',
  density: 'normal',
  statusStyle: 'color_text_icon',
};

const RADII = Object.keys(RADIUS) as RadiusKey[];
const DENSITIES = Object.keys(DENSITY) as DensityKey[];

/**
 * Читает раздел `theme` документа настроек. Неверное поле заменяется значением по умолчанию,
 * остальные сохраняются: сломанная настройка не должна ронять интерфейс.
 */
export function parseThemeSettings(raw: unknown): { settings: ThemeSettings; invalidKeys: string[] } {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const invalid: string[] = [];
  const pick = <T>(key: string, ok: (v: unknown) => v is T, fallback: T): T => {
    const v = src[key];
    if (v === undefined || v === null) return fallback;
    if (ok(v)) return v;
    invalid.push(key);
    return fallback;
  };
  const d = DEFAULT_THEME_SETTINGS;
  const darkRaw = src.dark && typeof src.dark === 'object' && !Array.isArray(src.dark) ? (src.dark as Record<string, unknown>) : {};
  if (src.dark !== undefined && src.dark !== null && darkRaw !== src.dark) invalid.push('dark');
  const pickDark = (key: keyof DarkSettings): string | null => {
    const v = darkRaw[key];
    if (v === undefined || v === null) return null;
    if (isHex(v)) return normalizeHex(v);
    invalid.push(`dark.${key}`);
    return null;
  };
  const settings: ThemeSettings = {
    defaultMode: pick<ThemeMode | null>('defaultMode', (v): v is ThemeMode => v === 'light' || v === 'dark' || v === 'system', null),
    dark: { canvas: pickDark('canvas'), surface: pickDark('surface'), brandColor: pickDark('brandColor'), accentColor: pickDark('accentColor') },
    brandColor: normalizeHex(pick('brandColor', isHex, d.brandColor)),
    accentColor: ((a) => (a ? normalizeHex(a) : null))(pick<string | null>('accentColor', isHex, null)),
    fontPreset: pick('fontPreset', (v): v is string => typeof v === 'string' && v.length > 0, d.fontPreset),
    radius: pick('radius', (v): v is RadiusKey => RADII.includes(v as RadiusKey), d.radius),
    density: pick('density', (v): v is DensityKey => DENSITIES.includes(v as DensityKey), d.density),
    statusStyle: pick('statusStyle', (v): v is StatusStyle => v === 'color' || v === 'color_text_icon', d.statusStyle),
  };
  return { settings, invalidKeys: invalid };
}

/**
 * Роли одного цвета бренда: заливка, цвет на заливке, наведение, подложка, текстовый вариант.
 * Если ни белый, ни тёмный текст не дают 4.5:1 на заданной заливке (средние тона, #777 и т. п.),
 * заливка сдвигается минимально — `adjusted: true`. Без сдвига текст на кнопке был бы нечитаем.
 */
export function deriveBrandRole(color: string) {
  const original = normalizeHex(color);
  let base = original;
  let onColor = readableOn(base, [WHITE, NEUTRALS.text]);
  if (contrast(onColor, base) < AA_TEXT) {
    // Затемняем под белый текст или светлим под тёмный — туда, где контраст уже лучше.
    const toward = onColor === WHITE ? BLACK : WHITE;
    for (let i = 1; i <= 100 && contrast(onColor, base) < AA_TEXT; i++) base = mix(original, toward, i / 100);
    onColor = readableOn(base, [WHITE, NEUTRALS.text]);
  }
  // Наведение сохраняет контраст: под белый текст темнеем, под тёмный — светлеем.
  const hover = mix(base, onColor === WHITE ? BLACK : WHITE, 0.14);
  const tint = mix(base, WHITE, 0.9);
  // Цвет для текста/ссылок/рамок: читается и на поверхности, и на подложке-тинте.
  const ink = ensureContrast(base, [NEUTRALS.surface, tint, NEUTRALS.canvas], AA_TEXT);
  return { base, onColor, hover, tint, ink, adjusted: base !== original };
}

/** Заливка не менее 3:1 к поверхности и подложке (WCAG 1.4.11): иначе кнопка сливается с фоном. */
const AA_FILL = 3;

/**
 * Роли цвета бренда на тёмном фоне. Заливка, которая сливается с поверхностью (< 3:1), осветляется до порога —
 * `adjusted: true`; текст на заливке — не ниже AA; цвет текста и ссылок осветляется до 4.5:1 к поверхности,
 * подложке и фону. Подложка — бренд, приглушённый в поверхность.
 */
export function deriveBrandRoleDark(color: string, canvas: string, surface: string) {
  const original = normalizeHex(color);
  const fillOk = (c: string) => contrast(c, surface) >= AA_FILL && contrast(c, canvas) >= AA_FILL;
  const onOf = (c: string) => readableOn(c, [WHITE, NEUTRALS.text]);
  let base = original;
  for (let i = 1; i <= 100 && !(fillOk(base) && contrast(onOf(base), base) >= AA_TEXT); i++) base = mix(original, WHITE, i / 100);
  const onColor = onOf(base);
  const hover = mix(base, onColor === WHITE ? BLACK : WHITE, 0.14);
  const tint = mix(surface, base, 0.2);
  const ink = ensureContrast(base, [surface, tint, canvas], AA_TEXT, WHITE);
  return { base, onColor, hover, tint, ink, adjusted: base !== original };
}

/** Все нейтральные и тона состояний тёмной темы читаются на выбранных фоне и поверхности. */
function darkSurfacesReadable(canvas: string, surface: string): boolean {
  const N = NEUTRALS_DARK;
  for (const k of ['text', 'text2', 'text3'] as const) {
    if (contrast(N[k], canvas) < AA_TEXT || contrast(N[k], surface) < AA_TEXT) return false;
  }
  if (contrast(N.borderStrong, surface) < AA_LARGE || contrast(N.borderStrong, canvas) < AA_LARGE) return false;
  return Object.values(STATES_DARK).every((s) => contrast(s.ink, canvas) >= AA_TEXT && contrast(s.ink, surface) >= AA_TEXT);
}

const px = (n: number) => `${n}px`;

export function computeTheme(raw: unknown, variant: ThemeVariant = 'light'): Theme {
  const { settings, invalidKeys } = parseThemeSettings(raw);
  const warnings: ThemeWarning[] = [];
  if (invalidKeys.length > 0) warnings.push('invalid-setting');

  const dark = variant === 'dark';
  const N = dark ? NEUTRALS_DARK : NEUTRALS;
  // Фон и поверхность клиента для тёмной темы: текст продукта обязан читаться на них (AA), иначе — палитра продукта
  let canvas: string = N.canvas;
  let surface: string = N.surface;
  if (dark) {
    const c = settings.dark.canvas ?? NEUTRALS_DARK.canvas;
    const sf = settings.dark.surface ?? NEUTRALS_DARK.surface;
    if (darkSurfacesReadable(c, sf)) {
      canvas = c;
      surface = sf;
    } else {
      warnings.push('dark-surface-invalid');
    }
  }
  const role = (color: string) => (dark ? deriveBrandRoleDark(color, canvas, surface) : deriveBrandRole(color));
  const brand = role(dark ? (settings.dark.brandColor ?? settings.brandColor) : settings.brandColor);
  const accent = role(dark ? (settings.dark.accentColor ?? settings.accentColor ?? settings.brandColor) : (settings.accentColor ?? settings.brandColor));
  if (dark && brand.adjusted) warnings.push('dark-brand-lightened');
  if (dark && accent.adjusted) warnings.push('dark-accent-lightened');
  const states = dark ? STATES_DARK : STATES;

  let font = FONT_PRESETS[settings.fontPreset];
  if (!font) {
    warnings.push('unknown-font-preset');
    font = FONT_PRESETS[DEFAULT_FONT_PRESET]!;
  }
  if (chroma(settings.brandColor) > 0.2 && hueDistance(hue(settings.brandColor), DANGER_HUE) <= 25) {
    warnings.push('brand-near-danger');
  }
  if (!dark && (brand.adjusted || accent.adjusted)) warnings.push('brand-adjusted');
  if (settings.statusStyle === 'color') warnings.push('status-color-only');

  const r = RADIUS[settings.radius];
  const dn = DENSITY[settings.density];

  const vars: Record<string, string> = {
    // Слой 1. Бренд
    '--brand': brand.base,
    '--brand-hover': brand.hover,
    '--brand-ink': brand.ink,
    '--brand-tint': brand.tint,
    '--on-brand': brand.onColor,
    '--accent': accent.base,
    '--accent-hover': accent.hover,
    '--accent-ink': accent.ink,
    '--accent-tint': accent.tint,
    '--on-accent': accent.onColor,
    '--ring': brand.ink,
    // Слой 2. Нейтральные
    '--canvas': canvas,
    '--surface': surface,
    '--text': N.text,
    '--text-2': N.text2,
    '--text-3': N.text3,
    '--border': N.border,
    '--border-strong': N.borderStrong,
    '--overlay': dark ? OVERLAY.dark : OVERLAY.light,
    // Логотип клиента не перекрашиваем: на тёмной теме он стоит на светлой плашке
    '--logo-plate': dark ? N.text : 'transparent',
    '--logo-pad': dark ? '3px 8px' : '0px',
    '--shadow-float': dark ? SHADOW_FLOAT.dark : SHADOW_FLOAT.light,
    // Форма и плотность
    '--radius-control': px(r.control),
    '--radius-card': px(r.card),
    '--radius-sheet': px(r.sheet),
    '--control-h': px(dn.control),
    '--tap-min': px(TAP_MIN),
    '--space-row': px(dn.rowY),
    '--space-gap': px(dn.gap),
    '--space-card': px(dn.card),
    '--text-base': px(dn.text),
    // Шрифты
    '--font-body': font.body,
    '--font-display': font.display,
    // Статусы: значок можно скрыть только настройкой, текст остаётся всегда
    '--status-icon-display': settings.statusStyle === 'color_text_icon' ? 'inline-flex' : 'none',
  };
  // Слой 3. Состояния
  for (const key of Object.keys(STATES) as StateKey[]) {
    vars[`--${key}`] = states[key].ink;
    vars[`--${key}-tint`] = states[key].tint;
  }
  // Текст на сплошной зелёной кнопке (кнопка «Позвонить»): белый на светлой теме, тёмный на светлом зелёном тёмной
  vars['--on-success'] = readableOn(states.success.ink, [WHITE, NEUTRALS.text]);
  return { settings, vars, warnings, invalidKeys };
}

/** Блок `:root { … }` для <style>. Значения — только из проверенных hex и таблиц, инъекции нет. */
export function themeToCss(vars: Record<string, string>, selector = ':root'): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  return `${selector}{${body}}`;
}

/**
 * Блок тёмной темы: только переменные, отличающиеся от светлой (форма, шрифты и плотность общие).
 * `selector` — например `:root[data-theme="dark"]`; `color-scheme: dark` подключает тёмные системные элементы.
 */
export function themeToCssDark(light: Record<string, string>, dark: Record<string, string>, selector: string): string {
  const diff = Object.fromEntries(Object.entries(dark).filter(([k, v]) => light[k] !== v));
  return themeToCss({ 'color-scheme': 'dark', ...diff }, selector);
}
