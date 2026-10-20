// Общий телефон (D-063, D-291): «Всё равно выйти» без сети не оставляет живую сессию; итог прежнего сотрудника не
// уходит под чужой сессией; после смены сотрудника данные прежнего обезличены. Нужна БД e2e (E2E_DATABASE_URL).
// Service worker здесь выключен: его поведение (метка выхода, оболочка из кэша) проверяют юнит-тесты sw.js, а маршруты
// Playwright надёжно перехватывают запросы только без него. Синтетика: +7 709 …, «ТОО Синтетика …».
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, callAndOutcome, callsOf, login, makeOperator, openCall, prepareDb, sql, type Operator } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.use({ serviceWorkers: 'block' });

test.beforeAll(() => {
  prepareDb();
});

const sessionsOf = async (userId: string): Promise<number> => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`)[0]!.n;

/** Цифры номеров клиентов оператора (как они лежали бы в хранилище) — для поиска следов на телефоне. */
async function phoneDigits(op: Operator): Promise<string[]> {
  const rows = await sql<{ digits: string }[]>`SELECT digits FROM client_phones WHERE client_id = ANY(${op.clientIds})`;
  return rows.map((r) => r.digits);
}

/** Всё, что лежит на телефоне: localStorage и IndexedDB. */
async function dumpDevice(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) out.push(`ls:${localStorage.key(i)}=${localStorage.getItem(localStorage.key(i)!)}`);
    for (const info of (await indexedDB.databases?.()) ?? []) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(info.name!);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const name of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((res, rej) => {
          const g = db.transaction(name).objectStore(name).getAll();
          g.onsuccess = () => res(g.result);
          g.onerror = () => rej(g.error);
        });
        out.push(`${info.name}/${name}=${JSON.stringify(rows)}`);
      }
      db.close();
    }
    return out.join('\n');
  });
}

async function expectNoTraces(page: Page, op: Operator): Promise<void> {
  const dump = await dumpDevice(page);
  for (const name of op.names) expect(dump).not.toContain(name);
  for (const d of await phoneDigits(op)) expect(dump).not.toContain(d.slice(-7));
  expect(dump).not.toContain('Асель Синтетик');
  expect(dump).not.toMatch(new RegExp(`^ls:crm\\.call\\.(pending|tally)\\.${op.id}`, 'm'));
}

test('«Всё равно выйти» без сети: экран блокировки на любой странице, итоги не уходят, сессия закрывается с появлением сети', async ({ page, context }) => {
  const op = await makeOperator(3, { lpr: true });
  await openCall(page, op);
  await context.setOffline(true);
  await callAndOutcome(page, 'no_answer');
  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('logout-unsent')).toBeVisible();
  await page.getByTestId('logout-force').click();

  // Сессия на сервере жива, поэтому на вход не уходим: экран блокировки вместо данных
  const lock = page.getByTestId('logout-lock');
  await expect(lock).toBeVisible();
  await expect(lock).toContainText('Выход завершится, когда появится сеть');
  await expect(page.getByTestId('call-screen')).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/call');
  expect(await sessionsOf(op.id)).toBe(1);

  // Сеть есть, но запрос выхода не проходит: новая загрузка любой страницы — снова блокировка, без данных и отправки
  await context.route('**/api/auth/logout', (r) => r.abort());
  await context.setOffline(false);
  // /call: карточки приходят из API, а его страница не запрашивает — названий нет даже в разметке
  await page.goto('/call');
  await expect(page.getByTestId('logout-lock')).toBeVisible();
  await expect(page.getByTestId('call-card')).toHaveCount(0);
  const html = await page.content();
  for (const name of op.names) expect(html).not.toContain(name);
  // Страница с серверной разметкой (список клиентов): сессия ещё жива, разметка пришла, но не рисуется
  await page.goto('/clients');
  await expect(page.getByTestId('logout-lock')).toBeVisible();
  const visible = await page.locator('body').innerText();
  for (const name of op.names) expect(visible).not.toContain(name);
  expect(await callsOf(op.id)).toHaveLength(0);

  // Выход проходит по таймеру: флаг снят, сессии нет, страница входа
  await context.unroute('**/api/auth/logout');
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  expect(await sessionsOf(op.id)).toBe(0);
  await expect(page.getByTestId('logout-lock')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('crm.logout.pending'))).toBeNull();
  await page.goto('/call');
  await expect(page).toHaveURL(/\/login/);
  await expectNoTraces(page, op);
  expect(await callsOf(op.id)).toHaveLength(0);

  // Тот же сотрудник вошёл снова: его итог уходит под ним
  await openCall(page, op);
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
});

test('сессия A истекла без выхода, вошёл B: черновик, счётчик и названия A удалены; итог A уходит только под A', async ({ page, context }) => {
  const a = await makeOperator(2, { lpr: true });
  const b = await makeOperator(1);
  await openCall(page, a);
  await context.setOffline(true);
  await callAndOutcome(page, 'no_answer');
  // Открытая шторка по второй карточке: «намерение звонка» с названием компании в localStorage
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  expect(await dumpDevice(page)).toContain(a.names[0]!);

  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  await context.setOffline(false);
  await login(page, b);
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
  await expect.poll(async () => {
    const dump = await dumpDevice(page);
    return a.names.some((n) => dump.includes(n));
  }).toBe(false);
  await expectNoTraces(page, a);
  expect(await callsOf(a.id)).toHaveLength(0);
  expect(await callsOf(b.id)).toHaveLength(0);

  // B вышел, A вошёл: итог A уходит под A
  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login/);
  await openCall(page, a);
  await expect.poll(async () => (await callsOf(a.id)).length, { timeout: 30_000 }).toBe(1);
  expect(await callsOf(b.id)).toHaveLength(0);
});

test('вкладка A под cookie B: сервер отвечает 409 wrong_user, итог A держится без названия и не пишется на B', async ({ page, context }) => {
  const a = await makeOperator(2);
  const b = await makeOperator(1);
  await openCall(page, a);
  // Итоги A не доходят до сервера, пока на телефоне входит B
  await context.route('**/api/calls/outcomes', (r) => r.abort());
  await callAndOutcome(page, 'no_answer');
  const statuses: number[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('/api/calls/outcomes')) statuses.push(r.status());
  });

  const other = await context.newPage();
  await login(other, b);
  await other.close();
  await context.unroute('**/api/calls/outcomes');

  // Вкладка A шлёт свой итог под cookie B: 409, страница перезагружается и становится страницей B
  await expect.poll(() => statuses.includes(409), { timeout: 40_000 }).toBe(true);
  await expect(page.getByTestId('call-card')).toBeVisible({ timeout: 20_000 });
  expect(await callsOf(a.id)).toHaveLength(0);
  expect(await callsOf(b.id)).toHaveLength(0);
  await expectNoTraces(page, a);
  const held = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('crm-call');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<Array<{ userId: string; title: string }>>((res) => {
      const g = db.transaction('outbox').objectStore('outbox').getAll();
      g.onsuccess = () => res(g.result as Array<{ userId: string; title: string }>);
    });
    db.close();
    return rows;
  });
  expect(held).toEqual([expect.objectContaining({ userId: a.id, title: '' })]);
});
