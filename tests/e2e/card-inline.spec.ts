// Ввод полей на месте в карточке клиента (D-356, линия card круга 3): клик по значению → ввод → Enter сохраняет одно
// поле, Esc отменяет без запроса, деньги «150 000 ₸», конфликт «Изменил другой сотрудник» и «Записать моё», у директора
// кнопок-полей нет. Нужна БД e2e и сервер с FEATURE_CALLBACK_V2=1. Телефон (Pixel 7) и ноутбук 1440×900.
// Только синтетика: номера +7 709 …, «ТОО Синтетика …».
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { CALLBACK_V2, DB_URL, login, loginByRequest, makeOperator, prepareDb, sql, type Operator } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(!CALLBACK_V2, 'нужен FEATURE_CALLBACK_V2=1');

const ORIGIN = `http://localhost:${Number(process.env.E2E_PORT) || 3100}`;

test.beforeAll(async () => {
  prepareDb();
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/support/card-fields.ts'], { stdio: 'inherit', env: { ...process.env } });
  // Сервер подхватывает новую ревизию настроек не чаще раза в 5 с
  await new Promise((r) => setTimeout(r, 6000));
});

const open = (page: Page, key: string) => page.getByTestId(`inline-open-${key}`);
const patches = (page: Page) => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH') seen.push(r.url());
  });
  return seen;
};
const customOf = async (clientId: string) => (await sql<{ custom: Record<string, unknown> }[]>`SELECT custom FROM clients WHERE id = ${clientId}`)[0]!.custom;

/** Пустые поля на телефоне свёрнуты: раскрываем, если есть кнопка. */
async function expandEmpties(page: Page): Promise<void> {
  // Свой переключатель у «Данных клиента» и у «Полей карточки»: после клика он исчезает
  for (let i = 0; i < 2; i++) {
    const toggle = page.getByTestId('inline-empty-toggle').first();
    if (await toggle.isVisible()) await toggle.click();
  }
}

async function seedClient(op: Operator, custom: Record<string, unknown>): Promise<string> {
  const id = op.clientIds[0]!;
  await sql`UPDATE clients SET custom = ${sql.json(custom as never)} WHERE id = ${id}`;
  return id;
}

for (const size of [{ name: 'телефон', viewport: undefined }, { name: 'ноутбук 1440', viewport: { width: 1440, height: 900 } }] as const) {
  test.describe(size.name, () => {
    if (size.viewport) test.use({ viewport: size.viewport, isMobile: false, hasTouch: false });

    test('клик по «Район» → ввод → Enter: значение на месте, в БД и в ленте; Esc — запроса нет', async ({ page }) => {
      const op = await makeOperator(1);
      const clientId = await seedClient(op, { district: 'Алмалы' });
      await login(page, op);
      await page.goto(`/clients/${clientId}`);
      const seen = patches(page);

      // Esc: ввод закрыт, прежнее значение, запроса нет
      await open(page, 'client-district').click();
      const input = page.getByRole('textbox', { name: 'Район' });
      await input.fill('Черновик');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('inline-form-client-district')).toHaveCount(0);
      await expect(open(page, 'client-district')).toHaveText('Алмалы');
      expect(seen).toHaveLength(0);

      // Потеря фокуса без изменения — тоже без запроса
      await open(page, 'client-district').click();
      await page.getByRole('textbox', { name: 'Район' }).blur();
      await expect(page.getByTestId('inline-form-client-district')).toHaveCount(0);
      expect(seen).toHaveLength(0);

      // Enter сохраняет одно поле
      await open(page, 'client-district').click();
      await page.getByRole('textbox', { name: 'Район' }).fill('Есиль');
      await page.keyboard.press('Enter');
      await expect(open(page, 'client-district')).toHaveText('Есиль');
      expect(seen).toHaveLength(1);
      expect((await customOf(clientId)).district).toBe('Есиль');

      // Лента: правка в «Истории правок»
      await page.getByRole('button', { name: 'История правок' }).click();
      await expect(page.getByText('Изменено «Район»').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('деньги: «150 000 ₸», ввод с пробелами, копейки — ошибка без запроса', async ({ page }) => {
      const op = await makeOperator(1);
      const clientId = await seedClient(op, { e2e_budget: 150000 });
      await login(page, op);
      await page.goto(`/clients/${clientId}`);
      const seen = patches(page);

      const budget = open(page, 'client-e2e_budget');
      expect((await budget.innerText()).replace(/[  ]/g, ' ')).toBe('150 000 ₸');

      await budget.click();
      const input = page.getByRole('textbox', { name: 'Бюджет' });
      await expect(input).toHaveValue('150 000');
      await input.fill('1 500,50');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Только целые тенге, например 150 000')).toBeVisible();
      expect(seen).toHaveLength(0);

      await input.fill('2500000');
      await expect(input).toHaveValue('2 500 000');
      await page.keyboard.press('Enter');
      await expect(open(page, 'client-e2e_budget')).toBeVisible();
      expect((await open(page, 'client-e2e_budget').innerText()).replace(/[  ]/g, ' ')).toBe('2 500 000 ₸');
      expect((await customOf(clientId)).e2e_budget).toBe(2500000);
    });

    test('список: выбор сохраняется сразу', async ({ page }) => {
      const op = await makeOperator(1);
      const clientId = await seedClient(op, { company_size: 'small' });
      await login(page, op);
      await page.goto(`/clients/${clientId}`);
      await open(page, 'client-company_size').click();
      await page.getByRole('combobox', { name: 'Размер компании' }).selectOption('medium');
      await expect(open(page, 'client-company_size')).toHaveText('Средняя');
      expect((await customOf(clientId)).company_size).toBe('medium');
    });

    test('поле карточки и системное поле: сохраняются своими запросами', async ({ page }) => {
      const op = await makeOperator(1);
      const clientId = op.clientIds[0]!;
      await login(page, op);
      await page.goto(`/clients/${clientId}`);
      await expandEmpties(page);
      await open(page, 'card-e2e_plan').click();
      await page.getByRole('textbox', { name: 'План' }).fill('Встреча в среду');
      await page.keyboard.press('Enter');
      await expect(open(page, 'card-e2e_plan')).toHaveText('Встреча в среду');
      const [card] = await sql<{ custom: Record<string, unknown> }[]>`SELECT custom FROM cards WHERE id = ${op.cardIds[0]!}`;
      expect(card?.custom.e2e_plan).toBe('Встреча в среду');

      await open(page, 'client-region').click();
      await page.getByRole('textbox', { name: 'Регион' }).fill('Астана');
      await page.keyboard.press('Enter');
      await expect(open(page, 'client-region')).toHaveText('Астана');
      const [row] = await sql<{ region: string }[]>`SELECT region FROM clients WHERE id = ${clientId}`;
      expect(row?.region).toBe('Астана');
    });

    test('второй сотрудник меняет поле: первый видит конфликт, «Записать моё» сохраняет', async ({ page, browser }) => {
      const op = await makeOperator(1);
      const clientId = await seedClient(op, { district: 'Алмалы' });
      await login(page, op);
      await page.goto(`/clients/${clientId}`);

      // Второй контекст того же сотрудника меняет поле раньше
      const other = await browser.newContext();
      await loginByRequest(other, op, ORIGIN);
      const r = await other.request.patch(`${ORIGIN}/api/clients/${clientId}`, {
        headers: { origin: ORIGIN },
        data: { set: { custom: { district: 'Бостандык' } }, expect: { custom: { district: 'Алмалы' } } },
      });
      expect(r.status()).toBe(200);
      await other.close();

      await open(page, 'client-district').click();
      await page.getByRole('textbox', { name: 'Район' }).fill('Мой район');
      await page.keyboard.press('Enter');
      const conflict = page.getByTestId('inline-conflict-client-district');
      await expect(conflict).toContainText('Изменил другой сотрудник: «Бостандык»');
      expect((await customOf(clientId)).district).toBe('Бостандык');

      await page.getByTestId('inline-write-mine').click();
      await expect(open(page, 'client-district')).toHaveText('Мой район');
      expect((await customOf(clientId)).district).toBe('Мой район');
    });

    test('«Оставить новое»: показывается чужое значение, моё не записывается', async ({ page, browser }) => {
      const op = await makeOperator(1);
      const clientId = await seedClient(op, { district: 'Алмалы' });
      await login(page, op);
      await page.goto(`/clients/${clientId}`);
      const other = await browser.newContext();
      await loginByRequest(other, op, ORIGIN);
      await other.request.patch(`${ORIGIN}/api/clients/${clientId}`, {
        headers: { origin: ORIGIN },
        data: { set: { custom: { district: 'Бостандык' } }, expect: { custom: { district: 'Алмалы' } } },
      });
      await other.close();
      await open(page, 'client-district').click();
      await page.getByRole('textbox', { name: 'Район' }).fill('Мой район');
      await page.keyboard.press('Enter');
      await page.getByTestId('inline-keep-new').click();
      await expect(open(page, 'client-district')).toHaveText('Бостандык');
      expect((await customOf(clientId)).district).toBe('Бостандык');
    });

    test('директор: поля — текст, кнопок-полей нет, «Изменить все» нет', async ({ page }) => {
      const dir = await makeOperator(1, { role: 'director' });
      const clientId = await seedClient(dir, { district: 'Алмалы' });
      await login(page, dir);
      await page.goto(`/clients/${clientId}`);
      await expect(page.getByTestId('inline-client-district')).toContainText('Алмалы');
      await expect(page.locator('[data-testid^="inline-open-"]')).toHaveCount(0);
      await expect(page.getByTestId('fields-edit-all')).toHaveCount(0);
      await expect(page.getByTestId('inline-empty-toggle')).toHaveCount(0);
    });
  });
}

test.describe('телефон', () => {
  test('пустые поля с правом свёрнуты в «Пустые поля (N)» и раскрываются на месте', async ({ page }) => {
    test.skip(!test.info().project.name.includes('pixel') && !test.info().project.name.includes('iphone'), 'только телефон');
    const op = await makeOperator(1);
    const clientId = await seedClient(op, { district: 'Алмалы' });
    await login(page, op);
    await page.goto(`/clients/${clientId}`);
    const toggle = page.getByTestId('inline-empty-toggle').first();
    await expect(toggle).toContainText('Пустые поля (');
    await expect(open(page, 'client-oked')).toBeHidden();
    await toggle.click();
    await expect(open(page, 'client-oked')).toBeVisible();
    await expect(page.getByTestId('inline-empty-toggle')).toHaveCount(1);
    // Подпись над значением (одна колонка)
    const box = await page.getByTestId('inline-client-district').evaluate((el) => {
      const dt = el.querySelector('dt')!.getBoundingClientRect();
      const dd = el.querySelector('dd')!.getBoundingClientRect();
      return { dtBottom: dt.bottom, ddTop: dd.top };
    });
    expect(box.ddTop).toBeGreaterThanOrEqual(box.dtBottom - 1);
  });

  test('кнопки ✓ и ✕ под полем 44 px: ✕ — без запроса, ✓ — сохраняет', async ({ page }) => {
    test.skip(!test.info().project.name.includes('pixel') && !test.info().project.name.includes('iphone'), 'только телефон');
    const op = await makeOperator(1);
    const clientId = await seedClient(op, { district: 'Алмалы' });
    await login(page, op);
    await page.goto(`/clients/${clientId}`);
    const seen = patches(page);
    await open(page, 'client-district').tap();
    const input = page.getByRole('textbox', { name: 'Район' });
    await expect(input).toHaveAttribute('enterkeyhint', 'done');
    const sizes = await page.evaluate(() => ['inline-save', 'inline-cancel'].map((id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.getBoundingClientRect()).map((r) => [r.width, r.height]));
    for (const [w, h] of sizes) {
      expect(w).toBeGreaterThanOrEqual(44);
      expect(h).toBeGreaterThanOrEqual(44);
    }
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await input.fill('Черновик');
    await page.getByTestId('inline-cancel').tap();
    await expect(open(page, 'client-district')).toHaveText('Алмалы');
    expect(seen).toHaveLength(0);

    await open(page, 'client-district').tap();
    await page.getByRole('textbox', { name: 'Район' }).fill('Сарыарка');
    await page.getByTestId('inline-save').tap();
    await expect(open(page, 'client-district')).toHaveText('Сарыарка');
    expect(seen).toHaveLength(1);
    expect((await customOf(clientId)).district).toBe('Сарыарка');
  });
});
