// Логотип клиента вместо названия (D-333): шапка телефона и ноутбука, экран входа, заголовки ответа, отказ загрузки.
// Нужен пресет с theme.brandMark = 'logo' (сид e2e — накладка клиента) и файл в CRM_ASSETS_DIR (prepare-db).
// Другой сид — не повод молча пропустить: сценарии падают с понятной причиной (skip запрещён правилами).
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL.
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, login, makeOperator, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.beforeAll(() => prepareDb());

async function brandSettings(): Promise<{ name: string; mark: string | null; logo: string }> {
  const [row] = await sql<{ name: string; mark: string | null; logo: string }[]>`
    SELECT doc->'org'->'productName'->>'ru' AS name, doc->'theme'->>'brandMark' AS mark, doc->'theme'->>'logo' AS logo
    FROM config_revisions WHERE scope = 'global' ORDER BY rev DESC LIMIT 1`;
  expect(row?.mark, 'сид e2e не тот: нужна накладка клиента с theme.brandMark = "logo" (слои base, kz, consulting-sales, clients/crp), иначе проверять нечего').toBe('logo');
  return { name: row!.name.trim(), mark: row!.mark, logo: row!.logo };
}

/** Размер картинки в странице: высота на экране и естественные размеры. */
async function imgMetrics(page: Page, root: string) {
  const img = page.getByTestId(root).locator('img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  return img.evaluate((el: HTMLImageElement) => {
    const b = el.getBoundingClientRect();
    return { w: b.width, h: b.height, right: b.right, nw: el.naturalWidth, nh: el.naturalHeight, alt: el.alt, src: el.getAttribute('src') ?? '' };
  });
}

const sizes = [
  { name: 'телефон', viewport: undefined, height: 28, role: 'operator', path: '/call' },
  { name: 'ноутбук 1440×900', viewport: { width: 1440, height: 900 }, height: 28, role: 'rop', path: '/' },
];

for (const s of sizes) {
  test(`шапка (${s.name}): логотип с alt=productName, высота ${s.height} px, помещается рядом с колокольчиком`, async ({ page }) => {
    const { name } = await brandSettings();
    if (s.viewport) await page.setViewportSize(s.viewport);
    // боковое меню (28 px) есть у менеджерских ролей; оператор и на ноутбуке остаётся в мобильной обвязке (28 px)
    const op = await makeOperator(1, { role: s.role });
    await login(page, op);
    await page.goto(s.path);
    const m = await imgMetrics(page, 'shell-brand');
    expect(m.alt).toBe(name);
    expect(Math.abs(m.h - s.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.w / m.h / (m.nw / m.nh) - 1)).toBeLessThanOrEqual(0.01);
    expect(m.w, 'не уже минимума брендбука (120 px)').toBeGreaterThanOrEqual(120);
    // ширина = высота × пропорции файла: логотип не ужат до колокольчика, не переносится и не обрезан
    const bell = await page.locator('a[aria-label^="Уведомления"]').first().evaluate((el) => el.getBoundingClientRect().left);
    expect(m.right, 'логотип не заходит на колокольчик').toBeLessThanOrEqual(bell);
    if (s.viewport) {
      const aside = await page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().right);
      expect(m.right, 'логотип в пределах колонки').toBeLessThanOrEqual(aside);
    }
    expect(Math.abs(m.w - s.height * (m.nw / m.nh)), 'ширина по пропорции файла, без ужатия').toBeLessThanOrEqual(1);
  });
}

test('экран входа: тот же логотип, высота 40 px', async ({ page }) => {
  const { name } = await brandSettings();
  await page.goto('/login');
  const m = await imgMetrics(page, 'shell-brand');
  expect(m.alt).toBe(name);
  expect(Math.abs(m.h - 40)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.w / m.h / (m.nw / m.nh) - 1)).toBeLessThanOrEqual(0.01);
});

test('ответ маршрута: заголовки, immutable по адресу из страницы, 304 по ETag', async ({ page, request }) => {
  const { logo } = await brandSettings();
  await page.goto('/login');
  const { src } = await imgMetrics(page, 'shell-brand');
  const r = await request.get(src);
  expect(r.status()).toBe(200);
  const h = r.headers();
  // тип — по расширению файла логотипа в теме (svg, png, webp)
  const ext = logo.slice(logo.lastIndexOf('.') + 1);
  expect(h['content-type']).toBe({ svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' }[ext]);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['content-security-policy']).toContain('sandbox');
  expect(h['cache-control']).toContain('immutable');
  expect(h['set-cookie']).toBeUndefined();
  const etag = h['etag'];
  expect(etag).toBeTruthy();
  const again = await request.get('/api/brand/logo', { headers: { 'If-None-Match': etag! } });
  expect(again.status()).toBe(304);
});

test('отказ загрузки: в шапке название текстом', async ({ page }) => {
  const { name } = await brandSettings();
  await page.route('**/api/brand/logo**', (route) => route.abort());
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto('/call');
  await expect(page.getByTestId('shell-brand')).toHaveText(name);
  await expect(page.getByTestId('shell-brand').locator('img')).toHaveCount(0);
});
