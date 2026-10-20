// Шрифты пресета `geologica_onest` (theme.fontPreset): локальные woff2 из public/fonts, без запросов
// к сторонним сервисам ни на сборке, ни в рантайме. Подмножества (latin, cyrillic, cyrillic-ext с
// казахскими буквами) — отдельные семейства с unicode-range; ниже они собраны в стеки переменных
// --font-geologica и --font-onest (диапазоны символов Google Fonts: latin, cyrillic, cyrillic-ext;
// значения инлайнятся — next/font требует литералы), на которые ссылается src/ui/theme/presets.ts.
// preload выключен: файлы грузятся, только если тема действительно ссылается на семейство.
import localFont from 'next/font/local';


const geologicaLatin = localFont({
  src: [{ path: '../../public/fonts/geologica-latin-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--ff-geologica-latin',
  display: 'swap',
  preload: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const geologicaCyrillic = localFont({
  src: [{ path: '../../public/fonts/geologica-cyrillic-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--ff-geologica-cyr',
  display: 'swap',
  preload: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116' }],
});
const geologicaCyrillicExt = localFont({
  src: [{ path: '../../public/fonts/geologica-cyrillic-ext-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--ff-geologica-cyrext',
  display: 'swap',
  preload: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F' }],
});
const onestLatin = localFont({
  src: [{ path: '../../public/fonts/onest-latin-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--ff-onest-latin',
  display: 'swap',
  preload: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }],
});
const onestCyrillic = localFont({
  src: [{ path: '../../public/fonts/onest-cyrillic-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--ff-onest-cyr',
  display: 'swap',
  preload: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116' }],
});
const onestCyrillicExt = localFont({
  src: [{ path: '../../public/fonts/onest-cyrillic-ext-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--ff-onest-cyrext',
  display: 'swap',
  preload: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F' }],
});

/** Классы с переменными семейств: ставятся на <html>. */
export const fontVariableClasses = [
  geologicaLatin,
  geologicaCyrillic,
  geologicaCyrillicExt,
  onestLatin,
  onestCyrillic,
  onestCyrillicExt,
]
  .map((f) => f.variable)
  .join(' ');

/** Стеки семейств для --font-geologica и --font-onest (подмножества подбираются браузером по символам). */
export const fontStackStyle = {
  '--font-geologica': 'var(--ff-geologica-latin), var(--ff-geologica-cyr), var(--ff-geologica-cyrext)',
  '--font-onest': 'var(--ff-onest-latin), var(--ff-onest-cyr), var(--ff-onest-cyrext)',
} as const;
