// Тема из настроек: theme.brandColor, accentColor, fontPreset, radius, density, statusStyle →
// набор CSS-переменных трёх слоёв (бренд, нейтральные, состояния). Остальное считается.
// Гарантии: текст на брендовой кнопке и бренд-текст на поверхности — не ниже AA (4.5:1).
import {
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
import {
  DANGER_HUE,
  DEFAULT_BRAND,
  DEFAULT_FONT_PRESET,
  DENSITY,
  FONT_PRESETS,
  NEUTRALS,
  RADIUS,
  STATES,
  TAP_MIN,
  type DensityKey,
  type RadiusKey,
  type StateKey,
} from './presets';

export type StatusStyle = 'color' | 'color_text_icon';

export type ThemeSettings = {
  brandColor: string;
  accentColor: string | null;
  fontPreset: string;
  radius: RadiusKey;
  density: DensityKey;
  statusStyle: StatusStyle;
};

export type ThemeWarning = 'invalid-setting' | 'unknown-font-preset' | 'brand-near-danger' | 'brand-adjusted' | 'status-color-only';

export type Theme = {
  settings: ThemeSettings;
  /** CSS-переменные: имя с '--' → значение. */
  vars: Record<string, string>;
  warnings: ThemeWarning[];
  /** Какие ключи настроек были неверны (для журнала). */
  invalidKeys: string[];
};

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
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
  const settings: ThemeSettings = {
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

const px = (n: number) => `${n}px`;

export function computeTheme(raw: unknown): Theme {
  const { settings, invalidKeys } = parseThemeSettings(raw);
  const warnings: ThemeWarning[] = [];
  if (invalidKeys.length > 0) warnings.push('invalid-setting');

  const brand = deriveBrandRole(settings.brandColor);
  const accent = deriveBrandRole(settings.accentColor ?? settings.brandColor);

  let font = FONT_PRESETS[settings.fontPreset];
  if (!font) {
    warnings.push('unknown-font-preset');
    font = FONT_PRESETS[DEFAULT_FONT_PRESET]!;
  }
  if (chroma(settings.brandColor) > 0.2 && hueDistance(hue(settings.brandColor), DANGER_HUE) <= 25) {
    warnings.push('brand-near-danger');
  }
  if (brand.adjusted || accent.adjusted) warnings.push('brand-adjusted');
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
    '--canvas': NEUTRALS.canvas,
    '--surface': NEUTRALS.surface,
    '--text': NEUTRALS.text,
    '--text-2': NEUTRALS.text2,
    '--text-3': NEUTRALS.text3,
    '--border': NEUTRALS.border,
    '--border-strong': NEUTRALS.borderStrong,
    '--overlay': 'rgb(20 22 27 / 48%)',
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
    vars[`--${key}`] = STATES[key].ink;
    vars[`--${key}-tint`] = STATES[key].tint;
  }
  return { settings, vars, warnings, invalidKeys };
}

/** Блок `:root { … }` для <style>. Значения — только из проверенных hex и таблиц, инъекции нет. */
export function themeToCss(vars: Record<string, string>, selector = ':root'): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  return `${selector}{${body}}`;
}
