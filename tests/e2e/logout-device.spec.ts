// Выход и общий телефон (D-063, D-291): пути выхода и следы клиентов на устройстве. Проверка утечки ищет цифры номеров
// клиентов из БД (7709…), названия, имя ЛПР во всём localStorage, всех базах IndexedDB и Cache Storage.
// Нужна БД e2e (E2E_DATABASE_URL). Синтетика: +7 709 …, «ТОО Синтетика …», «Асель Синтетик».
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DB_URL, callAndOutcome, callsOf, login, makeOperator, openCall, prepareDb, sql } from './support/calling';
import { callsOnCards, dumpDevice, expectNoClientTraces, sessionsOf } from './support/device';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

const menuLogout = async (page: Page) => {
  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByTestId('logout').click();
};

test.describe('с service worker (как на телефоне)', () => {
  test('обычный выход: сессия закрыта, в localStorage, IndexedDB и Cache Storage нет номеров, названий и ЛПР', async ({ page }) => {
    const op = await makeOperator(3, { lpr: true });
    await openCall(page, op);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await expect(page.getByTestId('call-card')).toBeVisible();
    // Итог ушёл, на второй карточке открыта шторка: в localStorage лежит черновик с названием компании
    await callAndOutcome(page, 'no_answer');
    await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
    await page.getByTestId('call-button').click();
    await expect(page.getByTestId('outcome-sheet')).toBeVisible();
    // Проверка не пустая: до выхода следы на устройстве есть
    await expect.poll(async () => (await dumpDevice(page)).includes(op.names[1]!)).toBe(true);
    expect(await sessionsOf(op.id)).toBe(1);

    await page.getByRole('button', { name: 'Закрыть' }).click();
    await menuLogout(page);
    await page.waitForURL(/\/login/);
    expect(await sessionsOf(op.id)).toBe(0);
    await expectNoClientTraces(page, op);
    await page.goto('/call');
    await expect(page).toHaveURL(/\/login/);
    await expectNoClientTraces(page, op);
  });
});

test.describe('пути выхода', () => {
  test.use({ serviceWorkers: 'block' });

  test('«Всё равно выйти» при отказе API итогов: сессия закрыта, неотправленный итог остаётся без названия', async ({ page, context }) => {
    const op = await makeOperator(3, { lpr: true });
    await openCall(page, op);
    await context.route('**/api/calls/outcomes', (r) => r.abort());
    await callAndOutcome(page, 'no_answer');
    await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 1', { timeout: 20_000 });
    await expect.poll(async () => (await dumpDevice(page)).includes(op.names[0]!)).toBe(true);

    await menuLogout(page);
    await expect(page.getByTestId('logout-unsent')).toContainText('1 итог ещё не отправлен');
    await page.getByTestId('logout-force').click();
    await page.waitForURL(/\/login/);

    expect(await sessionsOf(op.id)).toBe(0);
    await expectNoClientTraces(page, op);
    // Итог не потерян: лежит в IndexedDB устройства, но без названия компании
    const dump = await dumpDevice(page);
    expect(dump).toMatch(/idb:crm-call\/outbox=\[\{.*"userId":"/);
    expect(dump).toContain(op.id);
    expect(await callsOnCards(op.cardIds)).toHaveLength(0);
  });

  test('отказ сервера по итогу (rejected): запись об отказе с названием удалена при выходе', async ({ page, context }) => {
    const op = await makeOperator(3, { lpr: true });
    await openCall(page, op);
    await context.route('**/api/calls/outcomes', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_request', code: 'bad_request' }) }));
    await callAndOutcome(page, 'no_answer');
    // Отказ записан в IndexedDB вместе с названием компании (для баннера «Не принято сервером»)
    await expect.poll(async () => (await dumpDevice(page)).includes(`"title":"${op.names[0]}"`), { timeout: 40_000 }).toBe(true);
    expect(await callsOnCards(op.cardIds)).toHaveLength(0);

    await menuLogout(page);
    await page.waitForURL(/\/login/);
    expect(await sessionsOf(op.id)).toBe(0);
    await expectNoClientTraces(page, op);
  });

  test('выход без сети: флаг «выход не завершён», экран блокировки; сеть вернулась — сессия закрыта на сервере, данных на устройстве нет', async ({ page, context }) => {
    const op = await makeOperator(3, { lpr: true });
    await openCall(page, op);
    await callAndOutcome(page, 'no_answer');
    await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
    await page.getByTestId('call-button').click();
    await expect(page.getByTestId('outcome-sheet')).toBeVisible();
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await expect.poll(async () => (await dumpDevice(page)).includes(op.names[1]!)).toBe(true);

    await context.setOffline(true);
    await menuLogout(page);
    // Сессия на сервере жива (cookie httpOnly): на вход не уходим, флаг стоит, данные спрятаны экраном блокировки
    const lock = page.getByTestId('logout-lock');
    await expect(lock).toBeVisible();
    await expect(lock).toContainText('Выход завершится, когда появится сеть');
    expect(await page.evaluate(() => localStorage.getItem('crm.logout.pending'))).not.toBeNull();
    await expect(page.getByTestId('call-screen')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/call');
    expect(await sessionsOf(op.id)).toBe(1);
    // Пока сети нет, телефон уже очищен
    await expectNoClientTraces(page, op);

    // Сеть вернулась: выход доводится сам, сессии нет, /call ведёт на вход
    await context.setOffline(false);
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    expect(await sessionsOf(op.id)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('crm.logout.pending'))).toBeNull();
    const res = await context.request.get('/call', { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(res.headers()['location'] ?? '').toContain('/login');
    const html = await (await context.request.get('/call')).text();
    for (const name of op.names) expect(html).not.toContain(name);
    await expectNoClientTraces(page, op);
  });

  test('сессия A истекла, вошёл B: данных A нет, итог A не ушёл под B, сервер отвечает 409 wrong_user на чужой userId', async ({ page, context, baseURL }) => {
    const a = await makeOperator(3, { lpr: true });
    const b = await makeOperator(2);
    await openCall(page, a);
    await context.setOffline(true);
    await callAndOutcome(page, 'no_answer');
    await page.getByTestId('call-button').click();
    await expect(page.getByTestId('outcome-sheet')).toBeVisible();
    await expect.poll(async () => (await dumpDevice(page)).includes(a.names[1]!)).toBe(true);

    // Сессия A истекла без выхода (удалена в БД), на этом же телефоне входит B
    await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
    await context.setOffline(false);
    await login(page, b);
    await page.goto('/call');
    await expect(page.getByTestId('call-card')).toBeVisible();
    await expect(page.getByTestId('call-card')).toContainText(b.names[0]!);

    // Данных A нет, а итог A не уходит под B: ждём дольше окна повторов outbox
    await expectNoClientTraces(page, a);
    await page.waitForTimeout(8_000);
    await expectNoClientTraces(page, a);
    expect(await callsOnCards(a.cardIds)).toHaveLength(0);
    expect((await callsOf(b.id)).filter((c) => a.cardIds.includes(c.cardId))).toHaveLength(0);
    // Итог A не потерян, он ждёт входа A (в хранилище остался без названия)
    expect(await dumpDevice(page)).toContain(a.id);

    // Подделанный автор под сессией B: 409 wrong_user и ни одной строки в calls
    const headers = { 'content-type': 'application/json', origin: baseURL!, 'x-call-author': a.id };
    for (const path of ['/api/calls/outcomes', '/api/calls/skips']) {
      const res = await page.request.post(path, { headers, data: { opId: randomUUID(), cardId: a.cardIds[0] } });
      expect(res.status(), path).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'wrong_user' });
    }
    expect(await callsOnCards(a.cardIds)).toHaveLength(0);
    expect(await callsOf(b.id)).toHaveLength(0);
  });

  test('итог с именем и номером ЛПР без сети: «Всё равно выйти» нет — остаться (итог уходит под A) или удалить с подтверждением; после входа B следов ЛПР нет', async ({ page, context }) => {
    const a = await makeOperator(3, { lpr: true });
    const b = await makeOperator(1);
    const LPR_NAME = 'Берик Синтетик-ЛПР';
    const lprOutcome = async () => {
      await page.getByTestId('call-button').click();
      await expect(page.getByTestId('outcome-sheet')).toBeVisible();
      await page.getByTestId('lpr-no').click();
      await page.getByTestId('outcome-no_answer').click();
      // Поля «Как выйти на ЛПР»: имя, прямой номер, когда звонить
      const lpr = page.getByRole('group', { name: 'Как выйти на ЛПР' }).getByRole('textbox');
      await lpr.nth(0).fill(LPR_NAME);
      await lpr.nth(1).fill('+7 709 555 12 34');
      await page.getByTestId('sheet-save').click();
      await expect(page.getByTestId('outcome-sheet')).toBeHidden();
      // Тост «Отменить» закрывает кнопку «Ещё»; под курсором он не гаснет (WCAG 2.2.1) — уводим курсор и ждём
      await page.mouse.move(0, 0);
      await expect(page.locator('.k-toast__undo')).toBeHidden({ timeout: 30_000 });
    };
    const lprTraces = async () => {
      const dump = await dumpDevice(page);
      return [LPR_NAME, '555 12 34', '5551234'].filter((x) => dump.includes(x));
    };
    const openLogout = async () => {
      if (!(await page.getByTestId('logout').isVisible())) await page.getByRole('button', { name: 'Ещё' }).click();
      await page.getByTestId('logout').click();
    };

    await openCall(page, a);
    await context.setOffline(true);
    await lprOutcome();
    await expect.poll(lprTraces).toContain(LPR_NAME);

    // Выход без сети: итог с данными ЛПР оставить на телефоне нельзя — кнопки «Всё равно выйти» нет
    await openLogout();
    await expect(page.getByTestId('logout-unsent')).toContainText('С данными ЛПР или заметкой: 1');
    await expect(page.getByTestId('logout-force')).toHaveCount(0);
    await page.getByTestId('logout-stay').click();
    await page.getByRole('button', { name: 'Закрыть' }).click();
    // Остался: сеть вернулась — итог уходит под A вместе с данными ЛПР
    await context.setOffline(false);
    await expect.poll(async () => (await callsOf(a.id)).length, { timeout: 40_000 }).toBe(1);
    await expect.poll(lprTraces).toEqual([]);

    // Второй итог с ЛПР без сети: удалить с подтверждением
    await context.setOffline(true);
    await lprOutcome();
    await expect.poll(lprTraces).toContain(LPR_NAME);
    await openLogout();
    await page.getByTestId('logout-discard').click();
    await expect(page.getByTestId('logout-discard-ask')).toContainText('Удалить 1 итог?');
    await page.getByTestId('logout-discard-confirm').click();
    await expect(page.getByTestId('logout-lock')).toBeVisible();
    expect(await lprTraces()).toEqual([]);

    // Сеть вернулась: выход завершён, вошёл B — на телефоне нет ни ЛПР, ни названий, ни номеров клиентов A
    await context.setOffline(false);
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    expect(await sessionsOf(a.id)).toBe(0);
    await login(page, b);
    await page.goto('/call');
    await expect(page.getByTestId('call-card')).toContainText(b.names[0]!);
    expect(await lprTraces()).toEqual([]);
    await expectNoClientTraces(page, a);
    // Удалённый итог потерян явно (оператор подтвердил), под B ничего не записано
    expect(await callsOf(a.id)).toHaveLength(1);
    expect(await callsOnCards(a.cardIds)).toHaveLength(1);
    expect(await callsOf(b.id)).toHaveLength(0);
  });
});
