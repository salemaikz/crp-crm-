// Доска на ноутбуке в светлой и тёмной теме (pipeline-v2 §17, линия Q1): шесть колонок в ряд, огонёк просроченного
// перезвона, плитка «Договорились», итог покупок и экран «Мои покупки», доска РОП с фильтром сотрудника. Тема берётся
// из системы (ВП-12), поэтому схема задаётся контексту браузера. Нужна БД e2e и сервер с FEATURE_OP_BOARD=1,
// FEATURE_CALLBACK_V2=1 и FEATURE_THEME_DARK=1 (стенд). Синтетика: +7 709 …, «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { DB_URL, login, loginByRequest, makeOperator, prepareDb, sql } from './support/calling';
import { makeAgreed, makeWonDeal } from './support/board';
import { makeTrash, makeWonDealVariant, ropContext } from './support/board-r3';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_OP_BOARD !== '1' || process.env.FEATURE_CALLBACK_V2 !== '1', 'нужен запуск с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд)');
test.skip(process.env.FEATURE_THEME_DARK === '0', 'тёмная тема выключена флагом');

test.beforeAll(() => prepareDb());

const DAY = 86_400_000;
const COLUMNS = ['new', 'callback', 'br', 'bk', 'purchase', 'trash'];
const tileOf = (page: Page, name: string) => page.getByTestId('lead-tile').filter({ hasText: name });
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const colors = (page: Page, name: string) =>
  tileOf(page, name).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`ноутбук, ${scheme === 'light' ? 'светлая' : 'тёмная'} тема`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: scheme });

    test('оператор: все колонки в ряд, огонёк, «Договорились», покупки; экран читается и не ломает вёрстку', async ({ page }, testInfo) => {
      const op = await makeOperator(2);
      const [agreed] = await makeAgreed(op, 1);
      const won = await makeWonDeal(op.id, 150000);
      // Вторая карточка — перезвон, срок которого прошёл вчера (огонёк «просрочен»)
      await sql`UPDATE cards SET state = 'callback', callback_reason = 'think', callback_touches = 1, next_call_precision = 'day', next_call_at = ${Date.now() - 2 * DAY} WHERE id = ${op.cardIds[1]!}`;

      await login(page, op);
      await page.goto('/board');
      await expect(page.getByTestId('board-screen')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
      expect(await page.evaluate((sc) => matchMedia(`(prefers-color-scheme: ${sc})`).matches, scheme)).toBe(true);
      for (const key of COLUMNS) await expect(page.getByTestId(`column-${key}`)).toBeVisible();
      expect(await noHScroll(page)).toBe(true);

      const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const fresh = await colors(page, op.names[0]!);
      // Плитка отличима от фона и читается: цвет текста не равен цвету плитки
      expect(fresh.bg).not.toBe(fresh.text);
      if (scheme === 'dark') expect(fresh.bg).not.toBe('rgb(255, 255, 255)');
      else expect(canvas).not.toBe(fresh.text);

      const overdue = tileOf(page, op.names[1]!);
      await expect(overdue.getByTestId('tile-fire')).toContainText('Перезвон просрочен');
      await expect(tileOf(page, agreed!.name)).toBeVisible();
      await expect(page.getByTestId('purchases-month')).toContainText('150');
      await testInfo.attach(`board-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' });

      await page.getByTestId('purchases-link').click();
      await page.waitForURL('**/board/purchases');
      await expect(page.getByTestId('purchases-list').getByText(won.name)).toBeVisible();
      expect(await noHScroll(page)).toBe(true);
      const row = await page.getByTestId('purchases-list').evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
      expect(row.text).not.toBe(row.bg);
      await testInfo.attach(`purchases-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' });
    });

    test('РОП: доска с фильтром сотрудника на ноутбуке', async ({ page }, testInfo) => {
      const rop = await makeOperator(0, { role: 'rop' });
      await sql`UPDATE users SET name = ${'РОП Синтетик ' + rop.id.slice(0, 4)} WHERE id = ${rop.id}`;
      const op = await makeOperator(2);
      await login(page, rop);
      await page.goto('/deals/calling');
      await expect(page.getByTestId('board-manager-filters')).toBeVisible();
      await page.getByTestId('filter-owner').selectOption(op.id);
      await expect(tileOf(page, op.names[0]!)).toBeVisible();
      expect(await noHScroll(page)).toBe(true);
      await testInfo.attach(`rop-board-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' });
    });
  });
}

// Геометрия ряда колонок (ui-polish §9.2, B2): каждая колонка целиком в ряду и в окне, высота до низа окна, своя прокрутка.
const rightEdge = async (page: Page) => {
  const row = await page.getByTestId('board-columns').boundingBox();
  const inner = await page.evaluate(() => window.innerWidth);
  const out: Record<string, number> = {};
  for (const key of COLUMNS) {
    const b = await page.getByTestId(`column-${key}`).boundingBox();
    out[key] = b ? b.x + b.width : Infinity;
  }
  return { rowRight: row ? row.x + row.width : 0, inner, out };
};

test.describe('геометрия колонок на ноутбуке', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  for (const who of ['operator', 'rop'] as const) {
    test(`1440×900, ${who}: после прокрутки ряда вправо правый край каждой колонки не дальше края ряда и окна`, async ({ page }) => {
      const op = await makeOperator(8, who === 'rop' ? { role: 'rop' } : {});
      await login(page, op);
      await page.goto(who === 'rop' ? '/deals/calling' : '/board');
      await expect(page.getByTestId('board-screen')).toBeVisible();
      // Колонки не уже 17/15rem (D-358): ряд шире окна и прокручивается; в конце прокрутки каждая колонка целиком в ряду
      await page.getByTestId('board-columns').evaluate((el) => (el.scrollLeft = el.scrollWidth));
      await page.waitForTimeout(200);
      const g = await rightEdge(page);
      for (const key of COLUMNS) {
        expect(g.out[key]!, `колонка ${key}`).toBeLessThanOrEqual(g.rowRight + 0.5);
        expect(g.out[key]!, `колонка ${key}`).toBeLessThanOrEqual(g.inner + 0.5);
      }
      expect(await noHScroll(page)).toBe(true);
    });
  }

  test('после прокрутки «Новых» на 600 px шапки всех колонок видны', async ({ page }) => {
    const op = await makeOperator(20);
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('board-screen')).toBeVisible();
    await page.getByTestId('column-new').evaluate((el) => (el.scrollTop = 600));
    await page.waitForTimeout(200);
    for (const key of COLUMNS) {
      const h = await page.getByTestId(`column-header-${key}`).boundingBox();
      expect(h, key).not.toBeNull();
      expect(h!.y).toBeGreaterThanOrEqual(0);
      expect(h!.y + h!.height).toBeLessThanOrEqual(900);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('ряд колонок на 1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('ряд целиком в окне по вертикали, у документа нет горизонтальной прокрутки', async ({ page }) => {
    const op = await makeOperator(20);
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('board-screen')).toBeVisible();
    const row = await page.getByTestId('board-columns').boundingBox();
    expect(row!.y + row!.height).toBeLessThanOrEqual(800 + 0.5);
    expect(await noHScroll(page)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  });
});

// Плотность плитки на ноутбуке (ui-polish §9.3, B6): в «Новых» видно не меньше шести плиток, плитка не выше 100 px
test.describe('плотность на 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('«Новые»: не меньше шести плиток целиком, медианная высота ≤ 100 px, «Позвонить» круглая в первой строке, четвёртой строки нет', async ({ page }) => {
    const op = await makeOperator(9);
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('board-screen')).toBeVisible();
    await expect(page.getByTestId('lead-tile').first()).toBeVisible();
    const m = await page.evaluate(() => {
      const col = document.querySelector('[data-column-key="new"]')!.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('[data-column-key="new"] [data-testid="lead-tile"]')].map((el) => el.getBoundingClientRect());
      const head = document.querySelector('[data-testid="column-header-new"]')!.getBoundingClientRect();
      const heights = tiles.map((r) => r.height).sort((a, b) => a - b);
      return { whole: tiles.filter((r) => r.top >= head.bottom - 1 && r.bottom <= col.bottom + 1).length, median: heights[Math.floor(heights.length / 2)]! };
    });
    expect(m.whole).toBeGreaterThanOrEqual(6);
    expect(m.median).toBeLessThanOrEqual(100);
    const call = tileOf(page, op.names[0]!).getByTestId('tile-call');
    const box = (await call.boundingBox())!;
    const tileBox = (await tileOf(page, op.names[0]!).boundingBox())!;
    expect(Math.round(box.width)).toBe(32);
    // Кнопка справа в первой строке, «⋯» ниже неё: название получает почти всю ширину плитки
    expect(box.y - tileBox.y).toBeLessThan(20);
    const nameBox = (await tileOf(page, op.names[0]!).getByTestId('tile-open').boundingBox())!;
    expect(nameBox.width).toBeGreaterThanOrEqual(110);
    await expect(tileOf(page, op.names[0]!).getByTestId('tile-whatsapp')).toBeHidden();
  });
});

// Отпустили плитку на запрещённой колонке мышью: тост с причиной (ui-polish §9.3, B8)
test.describe('перенос мышью на 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('«Покупка» и запись — запрещённые цели: тост называет причину, плитка остаётся', async ({ page }) => {
    const op = await makeOperator(2);
    await login(page, op);
    await page.goto('/board');
    const from = (await tileOf(page, op.names[0]!).getByTestId('tile-open').boundingBox())!;
    for (const [col, text] of [['purchase', 'Покупку вносит сотрудник с правом на покупки'], ['br', 'Запись — через звонок']] as const) {
      const to = (await page.getByTestId(`column-${col}`).boundingBox())!;
      await page.mouse.move(from.x + 10, from.y + 10);
      await page.mouse.down();
      await page.mouse.move(from.x + 60, from.y + 20, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 12 });
      await page.mouse.up();
      await expect(page.getByText(text).first()).toBeVisible();
      await expect(page.getByTestId('column-new').getByText(op.names[0]!)).toBeVisible();
    }
  });
});

// Плитка на ноутбуке не ломается о ширину дорожки: просроченный перезвон не съедает чип причины, срок не выходит за рамку,
// название и ответственный читаются (pipeline-v2 §9.3).
for (const width of [1280, 1440]) {
  test.describe(`плитка на ${width}`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: false, hasTouch: false });

    test('просроченный перезвон: чип виден с текстом, срок в одну строку и внутри плитки', async ({ page }) => {
      const op = await makeOperator(2);
      await sql`UPDATE cards SET state = 'callback', callback_reason = 'think', callback_touches = 1, next_call_precision = 'day', next_call_at = ${Date.now() - 5 * DAY} WHERE id = ${op.cardIds[1]!}`;
      await login(page, op);
      await page.goto('/board');
      const tile = tileOf(page, op.names[1]!);
      await expect(tile.getByTestId('tile-due')).toBeVisible();
      const m = await tile.evaluate((el) => {
        const meta = el.querySelector('[data-testid="tile-meta"]') as HTMLElement;
        const chip = el.querySelector('[data-testid="tile-chip"]') as HTMLElement;
        const due = el.querySelector('[data-testid="tile-due"]') as HTMLElement;
        const box = el.getBoundingClientRect();
        const d = due.getBoundingClientRect();
        return {
          tileFits: el.scrollWidth <= el.clientWidth,
          metaFits: meta.scrollWidth <= meta.clientWidth,
          chipText: (chip.textContent ?? '').trim(),
          chipW: chip.getBoundingClientRect().width,
          dueInside: d.right <= box.right + 0.5,
          dueOneLine: d.height < parseFloat(getComputedStyle(due).lineHeight) * 1.6,
        };
      });
      expect(m.tileFits).toBe(true);
      expect(m.metaFits).toBe(true);
      expect(m.chipText.length).toBeGreaterThan(1);
      expect(m.chipW).toBeGreaterThanOrEqual(60);
      expect(m.dueInside).toBe(true);
      expect(m.dueOneLine).toBe(true);
    });
  });
}

// ---------- Круг 3, B2/B3 (D-358 п. 1–2): колонки не уже 17/15rem, ряд прокручивается, панель в две строки ----------
async function seedWide(page: Page, browser: Browser, baseURL: string, who: 'operator' | 'rop') {
  const op = await makeOperator(8, who === 'rop' ? { role: 'rop' } : {});
  await login(page, op);
  await makeTrash(op, 2);
  const ctx = await ropContext(browser, baseURL);
  await makeWonDealVariant(ctx, op, 150000);
  await makeWonDealVariant(ctx, op, 1_250_000, 'celina', 'offline');
  await ctx.close();
  return op;
}

test.describe('круг 3: ряд колонок и панель на 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  for (const who of ['operator', 'rop'] as const) {
    test(`${who}: ширина колонок ≥ 272/240, суммы и причины не обрезаны, плейсхолдер целиком, панель в двух строках`, async ({ page, browser, baseURL }) => {
      const op = await seedWide(page, browser, baseURL!, who);
      await page.goto(who === 'rop' ? '/deals/calling' : '/board');
      await expect(page.getByTestId('board-screen')).toBeVisible();
      await expect(page.getByTestId('lead-tile').first()).toBeVisible();

      const widths = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-column-key]')].map((el) => [(el as HTMLElement).dataset.columnKey!, el.getBoundingClientRect().width])));
      for (const key of ['new', 'callback', 'br', 'bk']) expect(widths[key]!, key).toBeGreaterThanOrEqual(272 - 0.5);
      for (const key of ['purchase', 'trash']) expect(widths[key]!, key).toBeGreaterThanOrEqual(240 - 0.5);

      // Конечные колонки: сумма «Покупки» и причина «Мусора» видны целиком (scrollWidth ≤ clientWidth)
      const clipped = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll('[data-testid="tile-end"], [data-testid="tile-end-label"], [data-testid="tile-end-date"], [data-testid="tile-sum"], [data-testid="tile-purchase-line"]')) {
          const e = el as HTMLElement;
          if (e.scrollWidth > e.clientWidth + 0.5) out.push(`${e.dataset.testid}: ${e.scrollWidth}>${e.clientWidth}`);
        }
        return out;
      });
      expect(clipped).toEqual([]);
      // Причина закрытия подписью из настроек, целиком (у РОП на странице бывают и чужие закрытые — проверяем любую)
      await expect(page.getByTestId('column-trash').getByTestId('tile-end-label').first()).toHaveText(/\S+ ·$/);

      // Плейсхолдер поиска помещается целиком (измеряем шрифтом поля)
      const ph = await page.getByTestId('board-search').evaluate((el) => {
        const i = el as HTMLInputElement;
        const cs = getComputedStyle(i);
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return { text: ctx.measureText(i.placeholder).width, room: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
      });
      expect(ph.text).toBeLessThanOrEqual(ph.room);

      // Строка 1: поиск и «Звонить подряд» (у РОП — «?») в одном ряду; строка 2: чипы ниже
      const search = (await page.getByTestId('board-search').boundingBox())!;
      const right = (await page.getByTestId(who === 'rop' ? 'board-help' : 'board-call-next').boundingBox())!;
      expect(Math.abs(search.y + search.height / 2 - (right.y + right.height / 2))).toBeLessThanOrEqual(2 + 6);
      const chip = (await page.getByTestId('filter-attendedGroup').boundingBox())!;
      expect(chip.y).toBeGreaterThan(search.y + search.height - 1);
      expect(await noHScroll(page)).toBe(true);
    });

    test(`${who}: ряд прокручивается с видимой полосой, «›» двигает ряд, «Мусор» после прокрутки в окне`, async ({ page, browser, baseURL }) => {
      const op = await seedWide(page, browser, baseURL!, who);
      await page.goto(who === 'rop' ? '/deals/calling' : '/board');
      await expect(page.getByTestId('lead-tile').first()).toBeVisible();
      const row = page.getByTestId('board-columns');
      const m = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, gutter: getComputedStyle(el).scrollbarGutter, bar: getComputedStyle(el).scrollbarWidth }));
      expect(m.sw).toBeGreaterThan(m.cw);
      expect(m.gutter).toContain('stable');
      // Полоса не скрыта (headless-Chromium прячет её сам, поэтому проверяем настройку, а не высоту)
      expect(m.bar).not.toBe('none');
      // «Мусор» вне окна до прокрутки
      const before = (await page.getByTestId('column-trash').boundingBox())!;
      expect(before.x + before.width).toBeGreaterThan(1440);
      await page.getByTestId('board-scroll-next').click();
      await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
      await row.evaluate((el) => (el.scrollLeft = el.scrollWidth));
      const after = (await page.getByTestId('column-trash').boundingBox())!;
      expect(after.x + after.width).toBeLessThanOrEqual(1440 + 0.5);
      expect(after.x).toBeGreaterThanOrEqual(0);
      const end = await row.evaluate((el) => ({ l: el.scrollLeft, c: el.clientWidth, s: el.scrollWidth }));
      await expect(page.getByTestId('board-scroll-next'), JSON.stringify(end)).toBeDisabled();
    });
  }

  test('плитки: название не заходит под «Позвонить», левая граница текста у белых и цветных одинакова', async ({ page, browser, baseURL }) => {
    const op = await makeOperator(6);
    const agreed = await makeAgreed(op, 2);
    // Явку отмечает РОП через API (оператор свою запись отметить не может)
    const rop = await makeOperator(0, { role: 'rop' });
    const ropCtx = await browser.newContext();
    await loginByRequest(ropCtx, rop, baseURL!);
    const att = await ropCtx.request.post(`/api/bookings/${agreed[0]!.bookingId}/attendance`, {
      headers: { origin: baseURL!, 'content-type': 'application/json' },
      data: { opId: randomUUID(), version: 0, to: 'attended' },
    });
    expect(att.status(), await att.text()).toBe(200);
    await ropCtx.close();
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('lead-tile').first()).toBeVisible();
    const overlaps = await page.evaluate(() => {
      const out: string[] = [];
      for (const tile of document.querySelectorAll('[data-testid="lead-tile"]')) {
        const open = tile.querySelector('[data-testid="tile-open"]')?.getBoundingClientRect();
        const call = tile.querySelector('[data-testid="tile-call"]')?.getBoundingClientRect();
        const menu = tile.querySelector('[data-testid="tile-menu"]')?.getBoundingClientRect();
        for (const other of [call, menu]) {
          if (open && other && open.right > other.left + 0.5 && open.left < other.right && open.bottom > other.top && open.top < other.bottom) out.push(tile.textContent!.slice(0, 20));
        }
      }
      return out;
    });
    expect(overlaps).toEqual([]);
    const left = async (name: string) => (await tileOf(page, name).getByTestId('tile-open').boundingBox())!.x;
    const toneTile = tileOf(page, agreed[0]!.name);
    expect(await toneTile.getAttribute('data-tone')).not.toBeNull();
    expect(Math.abs((await left(agreed[0]!.name)) - (await left(agreed[1]!.name)))).toBeLessThanOrEqual(1);
  });
});

// ---------- B4 (D-357): покупка с вариантом — «услуга · вариант» из настроек и сумма целиком ----------
for (const [name, viewport, mobile] of [['1440', { width: 1440, height: 900 }, false], ['Pixel 7', { width: 412, height: 915 }, true]] as const) {
  test.describe(`покупка с вариантом, ${name}`, () => {
    test.use({ viewport, isMobile: mobile, hasTouch: mobile });

    test('плитка «Покупка» и «Мои покупки»: «Целина · Онлайн» и «1 250 000 ₸ · дата» целиком', async ({ page, browser, baseURL }) => {
      const op = await makeOperator(1);
      await login(page, op);
      const ctx = await ropContext(browser, baseURL!);
      const won = await makeWonDealVariant(ctx, op, 1_250_000, 'celina', 'online');
      await ctx.close();
      await page.goto('/board');
      await expect(page.getByTestId('board-screen')).toBeVisible();
      if (mobile) await page.getByTestId('tab-purchase').click();
      const tile = tileOf(page, won.name);
      await expect(tile.getByTestId('tile-purchase-service')).toHaveText('Целина · Онлайн');
      const line = tile.getByTestId('tile-purchase-line');
      await expect(line).toHaveText(/^1\s250\s000\s₸ · \d\d\.\d\d$/);
      // Сумма не режется: влезает в свой элемент и в колонку (на ноутбуке «Покупка» может стоять за краем окна)
      await expect.poll(() => line.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= el.closest('[data-column-key]')!.getBoundingClientRect().right + 0.5)).toBe(true);

      await page.goto('/board/purchases');
      const item = page.getByTestId('purchases-list').getByText(won.name);
      await expect(item).toBeVisible();
      await expect(page.getByTestId('purchase-service').first()).toHaveText('Целина · Онлайн');
      await expect(page.getByTestId('purchase-amount').first()).toHaveText(/^1\s250\s000\s₸ · \d\d\.\d\d\.\d{4}$/);
      expect(await noHScroll(page)).toBe(true);
    });
  });
}

// ---------- B8 (дефект 10): плитка РОП — аватар ответственного, тумблеры явки одной строкой ----------
test.describe('доска РОП на 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('плитка ≤ 120 px, аватар 20 px перед «⋯», тумблеры в одном ряду по 28 px', async ({ page }) => {
    const rop = await makeOperator(0, { role: 'rop' });
    const op = await makeOperator(1);
    const agreed = await makeAgreed(op, 2);
    await sql`UPDATE users SET name = ${'Айгерим Синтетик'} WHERE id = ${op.id}`;
    await login(page, rop);
    await page.goto('/deals/calling');
    await expect(tileOf(page, agreed[0]!.name)).toBeVisible();
    const tile = tileOf(page, agreed[0]!.name);
    const box = (await tile.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(120);
    const avatar = (await tile.getByTestId('tile-owner').boundingBox())!;
    expect(Math.round(avatar.width)).toBe(20);
    expect(Math.round(avatar.height)).toBe(20);
    await expect(tile.getByTestId('tile-owner')).toHaveAttribute('title', /Айгерим Синтетик/);
    // Подсказка доступна мышью: под курсором в центре аватара сам аватар, а не растянутая кнопка плитки
    await tile.getByTestId('tile-owner').scrollIntoViewIfNeeded();
    const hit = await tile.getByTestId('tile-owner').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el.contains(top) ? 'ok' : (top?.outerHTML.slice(0, 200) ?? 'null');
    });
    expect(hit).toBe('ok');
    await expect(tile.getByTestId('tile-owner')).toHaveAttribute('aria-label', /Айгерим Синтетик/);
    const menu = (await tile.getByTestId('tile-menu').boundingBox())!;
    expect(avatar.x + avatar.width).toBeLessThanOrEqual(menu.x + 0.5);
    expect(Math.abs(avatar.y - box.y)).toBeLessThan(24);
    const toggles = await tile.locator('[data-testid^="tile-toggle-"]').evaluateAll((els) => els.map((e) => ({ top: Math.round(e.getBoundingClientRect().top), h: Math.round(e.getBoundingClientRect().height) })));
    expect(toggles.length).toBeGreaterThanOrEqual(1);
    expect(new Set(toggles.map((x) => x.top)).size).toBe(1);
    for (const x of toggles) expect(x.h).toBeLessThanOrEqual(28);
  });
});
