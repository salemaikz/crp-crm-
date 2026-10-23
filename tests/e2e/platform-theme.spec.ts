// Тёмная тема (D-342): личный переключатель, cookie crm_theme переживает перезагрузку, вид «как в системе»,
// снимки обеих тем на iPhone 13 и Pixel 7 (вход, /call, доска сделок, панель директора). Только синтетика.
// Без флага (FEATURE_THEME_DARK=0) переключателя нет и тёмная тема по системе не включается — тот же файл,
// запущенный с FEATURE_THEME_DARK=0. БД — E2E_DATABASE_URL.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, login, makeOperator, prepareDb } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.beforeAll(() => prepareDb());

const FLAG_OFF = process.env.FEATURE_THEME_DARK === '0';
// Фон тёмной темы берётся из theme.dark.canvas пресета клиента (не из умолчания кода) и светлой по умолчанию (#f5f6f8)
const presetCanvas = (JSON.parse(readFileSync(join(process.cwd(), 'presets/clients/crp/preset.json'), 'utf8')) as {
  global: { theme: { dark: { canvas: string } } };
}).global.theme.dark.canvas;
const toRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const DARK_CANVAS = toRgb(presetCanvas);
// Умолчание кода (NEUTRALS_DARK.canvas): пресет обязан его перекрывать
const CODE_DARK_CANVAS = 'rgb(18, 19, 22)';
const LIGHT_CANVAS = 'rgb(245, 246, 248)';

const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim());
const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));

/** Переменная — hex; приводим к rgb() для сравнения. */
async function canvasRgb(page: Page): Promise<string> {
  const hex = await bg(page);
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function openSwitch(page: Page): Promise<void> {
  // телефон: переключатель в «Ещё»; ноутбук (боковая колонка) — всегда на виду
  if (!(await page.getByTestId('theme-dark').first().isVisible())) await page.getByRole('button', { name: 'Ещё' }).click();
}

async function snap(page: Page, name: string, testInfo: import('@playwright/test').TestInfo): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
}

test.describe('флаг включён', () => {
  test.skip(FLAG_OFF, 'проверка с включённым THEME_DARK');

  test('вход: без cookie тема следует системе; тёмная — фон пресета, текст читается', async ({ browser }, testInfo) => {
    const dark = await browser.newContext({ colorScheme: 'dark' });
    const p = await dark.newPage();
    await p.goto('/login');
    expect(await dataTheme(p)).toBeNull();
    expect(await canvasRgb(p)).toBe(DARK_CANVAS);
    expect(DARK_CANVAS).not.toBe(CODE_DARK_CANVAS);
    expect(await p.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    // поле входа тёмное, а не белое
    const inputBg = await p.getByLabel('Номер телефона').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(inputBg).not.toBe('rgb(255, 255, 255)');
    await snap(p, 'login-dark', testInfo);
    await dark.close();
    const light = await browser.newContext({ colorScheme: 'light' });
    const l = await light.newPage();
    await l.goto('/login');
    expect(await canvasRgb(l)).toBe(LIGHT_CANVAS);
    await snap(l, 'login-light', testInfo);
    await light.close();
  });

  test('переключатель: тёмная → cookie → перезагрузка без мигания; светлая и «как в системе»', async ({ page, context }, testInfo) => {
    const op = await makeOperator(1);
    await login(page, op);
    await page.goto('/call');
    await expect(page.getByTestId('call-card')).toBeVisible();
    await openSwitch(page);
    await page.getByTestId('theme-dark').click();
    expect(await dataTheme(page)).toBe('dark');
    expect(await canvasRgb(page)).toBe(DARK_CANVAS);
    const cookie = (await context.cookies()).find((c) => c.name === 'crm_theme');
    expect(cookie?.value).toBe('dark');
    expect(cookie?.httpOnly).toBe(false);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');

    // перезагрузка: атрибут стоит уже в разметке, от сервера (без скрипта)
    const html = await (await page.request.get('/login', { headers: { cookie: 'crm_theme=dark' } })).text();
    expect(html).toMatch(/<html[^>]*data-theme="dark"/);
    await page.reload();
    expect(await dataTheme(page)).toBe('dark');
    await expect(page.getByTestId('call-card')).toBeVisible();
    await snap(page, 'call-dark', testInfo);

    // светлая
    await openSwitch(page);
    await page.getByTestId('theme-light').click();
    expect(await dataTheme(page)).toBe('light');
    expect(await canvasRgb(page)).toBe(LIGHT_CANVAS);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await canvasRgb(page), 'явная светлая сильнее системной тёмной').toBe(LIGHT_CANVAS);
    await snap(page, 'call-light', testInfo);

    // как в системе
    await page.getByTestId('theme-system').click();
    expect(await dataTheme(page)).toBeNull();
    expect(await canvasRgb(page)).toBe(DARK_CANVAS);
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await canvasRgb(page)).toBe(LIGHT_CANVAS);
    expect((await context.cookies()).find((c) => c.name === 'crm_theme')?.value).toBe('system');
  });

  test('доска сделок и панель директора в тёмной теме: фон и кнопка «Позвонить» читаются', async ({ page, context, baseURL }, testInfo) => {
    await context.addCookies([{ name: 'crm_theme', value: 'dark', url: baseURL! }]);
    const op = await makeOperator(1);
    await login(page, op);
    await page.goto('/call');
    const call = page.getByTestId('call-button');
    await expect(call).toBeVisible();
    const [fg, back] = await call.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor];
    });
    expect(fg).not.toBe('rgb(255, 255, 255)'); // на светлом зелёном тёмного вида текст тёмный
    expect(back).not.toBe(fg);

    const dir = await makeOperator(0, { role: 'director' });
    const dctx = await page.context().browser()!.newContext({ baseURL, colorScheme: 'light' });
    await dctx.addCookies([{ name: 'crm_theme', value: 'dark', url: baseURL! }]);
    const dp = await dctx.newPage();
    await login(dp, dir);
    for (const path of ['/deals', '/director']) {
      const res = await dp.goto(path);
      expect(res?.status() ?? 0, path).toBeLessThan(400);
      expect(await dataTheme(dp)).toBe('dark');
      expect(await canvasRgb(dp)).toBe(DARK_CANVAS);
      await snap(dp, `${path.slice(1)}-dark`, testInfo);
    }
    await dctx.close();
  });
});

test.describe('флаг выключен', () => {
  test.skip(!FLAG_OFF, 'запускать с FEATURE_THEME_DARK=0');

  test('переключателя нет, cookie и тёмная система игнорируются', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, colorScheme: 'dark' });
    await ctx.addCookies([{ name: 'crm_theme', value: 'dark', url: baseURL! }]);
    const page = await ctx.newPage();
    const op = await makeOperator(1);
    await login(page, op);
    await page.goto('/call');
    await expect(page.getByTestId('call-card')).toBeVisible();
    expect(await dataTheme(page)).toBeNull();
    expect(await canvasRgb(page)).toBe(LIGHT_CANVAS);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
    await page.getByRole('button', { name: 'Ещё' }).click();
    await expect(page.getByTestId('theme-dark')).toHaveCount(0);
    await ctx.close();
  });
});
