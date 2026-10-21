// Общий телефон (D-063, D-291): «Всё равно выйти» без сети не оставляет живую сессию; итог прежнего сотрудника не
// уходит под чужой сессией; после смены сотрудника данные прежнего обезличены. Нужна БД e2e (E2E_DATABASE_URL).
// Service worker здесь выключен: его поведение (метка выхода, оболочка из кэша) проверяют юнит-тесты sw.js, а маршруты
// Playwright надёжно перехватывают запросы только без него. Синтетика: +7 709 …, «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, callAndOutcome, callsOf, login, loginByRequest, makeOperator, openCall, prepareDb, sql, type Operator } from './support/calling';
import { expectNoClientTraces } from './support/device';

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
  // /call: метка «выход не завершён» уходит с запросом страницы — сервер сам закрывает сессию (D-310), запрос выхода
  // для этого уже не нужен; названий нет даже в разметке
  await page.goto('/call');
  await expect(page.getByTestId('logout-lock')).toBeVisible();
  await expect(page.getByTestId('call-card')).toHaveCount(0);
  const html = await page.content();
  for (const name of op.names) expect(html).not.toContain(name);
  expect(await sessionsOf(op.id)).toBe(0);
  // Страница с серверной разметкой (список клиентов): сессии нет — разметки с данными тоже
  await page.goto('/clients');
  await expect(page.getByTestId('logout-lock')).toBeVisible();
  const visible = await page.content();
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
  // Сеть вернулась, сессии A нет: страница A сама прячется и уходит на вход (D-292)
  await page.waitForURL(/\/login/);
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

// Страницы B не открывались (вход запросом), поэтому метка владельца телефона вкладку A не перезагружает: остаётся
// защита на сервере. Со страницей B вкладка A перезагружается сразу — сценарий «вторая вкладка» ниже.
test('вкладка A под cookie B: сервер отвечает 409 wrong_user, итог A держится без названия и не пишется на B', async ({ page, context, baseURL }) => {
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

  await loginByRequest(context, b, baseURL!);
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

/** B вернулся на вкладку A: страница снова видна, у неё фокус, сеть есть (как при переключении вкладок на телефоне). */
async function comeBack(tab: Page): Promise<void> {
  await tab.bringToFront();
  await tab.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
  });
}

/** Вкладка показывает экран B, а не A: ни названий, ни ЛПР A в видимом тексте и разметке. */
async function expectTabOf(tab: Page, a: Operator, b: Operator): Promise<void> {
  await expect(tab.getByTestId('call-card')).toContainText(b.names[0]!, { timeout: 20_000 });
  const text = await tab.locator('body').innerText();
  const html = await tab.content();
  for (const n of a.names) {
    expect(text).not.toContain(n);
    expect(html).not.toContain(n);
  }
  expect(text).not.toContain('Асель Синтетик');
}

test('вторая вкладка A без неотправленных итогов: вошёл B — вкладка A прячется и становится страницей B, черновик A не пишется', async ({ page, context }) => {
  const a = await makeOperator(2, { lpr: true });
  const b = await makeOperator(1);
  await openCall(page, a);
  const tab2 = await context.newPage();
  await tab2.goto('/call');
  await expect(tab2.getByTestId('call-card')).toContainText(a.names[0]!);

  // Сессия A истекла, в первой вкладке вошёл B и открыл «Звонить»
  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  await login(page, b);
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toContainText(b.names[0]!);

  await comeBack(tab2);
  await expectTabOf(tab2, a, b);
  // «Позвонить» во второй вкладке — это уже карточка B: «намерение звонка» A на телефон не пишется
  await tab2.getByTestId('call-button').click();
  await expect(tab2.getByTestId('outcome-sheet')).toBeVisible();
  const keys = await tab2.evaluate(() => Object.keys(localStorage));
  expect(keys).not.toContain(`crm.call.pending.${a.id}`);
  expect(keys).toContain(`crm.call.pending.${b.id}`);
  await expectNoClientTraces(tab2, a);
  expect(await callsOf(a.id)).toHaveLength(0);
  expect(await callsOf(b.id)).toHaveLength(0);
});

test('вкладка A, а B вошёл без открытия страниц (метки владельца нет): сервер отвечает 409 на чтение очереди, вкладка становится страницей B', async ({ page, context, baseURL }) => {
  const a = await makeOperator(2, { lpr: true });
  const b = await makeOperator(1);
  await openCall(page, a);
  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  // Вход B только запросом (cookie та же, что у вкладки): ни одна страница B не загружалась и метку не ставила
  await loginByRequest(context, b, baseURL!);
  expect(await page.evaluate(() => localStorage.getItem('crm.device.owner'))).not.toBe(b.id);

  const reads: number[] = [];
  page.on('response', (r) => {
    if (/\/api\/calls\/(queue|today)/.test(r.url())) reads.push(r.status());
  });
  await comeBack(page);
  await expect.poll(() => reads.includes(409), { timeout: 15_000 }).toBe(true);
  await expectTabOf(page, a, b);
  await expectNoClientTraces(page, a);
});

// ---- Возврат на вкладку вне «Звонить» и истёкшая сессия (D-292, красная команда, круг 2) ------------------------------

/** Возврат на вкладку как при переключении на телефоне: видимость, фокус, показ. Событие `online` — только если просили. */
async function returnTo(tab: Page, opts: { online?: boolean } = {}): Promise<void> {
  await tab.bringToFront();
  await tab.evaluate((online) => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    if (online) window.dispatchEvent(new Event('online'));
  }, opts.online === true);
}

/** На экране вкладки нет ни названий клиентов A, ни его ЛПР (видимый текст). */
async function expectHiddenFrom(tab: Page, a: Operator): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = await tab.locator('body').innerText().catch(() => '');
        return a.names.some((n) => text.includes(n)) || text.includes('Асель Синтетик');
      },
      { timeout: 8_000 },
    )
    .toBe(false);
}

test('вкладка A на карточке клиента, B вошёл через /login?next=/account: вкладка A прячется, черновик и счётчик A удалены', async ({ page, context }) => {
  const a = await makeOperator(2, { lpr: true });
  const b = await makeOperator(1);
  await openCall(page, a);
  // Счётчик A (итог ушёл) и черновик A (шторка по второй карточке) на телефоне
  await callAndOutcome(page, 'no_answer');
  await expect.poll(async () => (await callsOf(a.id)).length, { timeout: 30_000 }).toBe(1);
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  const keysA = await page.evaluate(() => Object.keys(localStorage));
  expect(keysA).toContain(`crm.call.pending.${a.id}`);
  expect(keysA).toContain(`crm.call.tally.${a.id}`);

  const tab2 = await context.newPage();
  await tab2.goto(`/clients/${a.clientIds[0]}`);
  await expect(tab2.locator('body')).toContainText(a.names[0]!);
  await expect(tab2.locator('body')).toContainText('Асель Синтетик');

  // Сессия A истекла; в первой вкладке B входит, и первая его страница — не оболочка, а /account
  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  await page.goto('/login?next=/account');
  await page.getByLabel('Номер телефона').fill(`8 ${b.phone.slice(1, 4)} ${b.phone.slice(4, 7)} ${b.phone.slice(7, 9)} ${b.phone.slice(9)}`);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname === '/account');
  // Метку владельца телефона поставил вход, сессия B действует
  expect(await page.evaluate(() => localStorage.getItem('crm.device.owner'))).toBe(b.id);
  expect(await page.evaluate(async () => (await fetch('/api/calls/today', { cache: 'no-store' })).status)).toBe(200);

  await returnTo(tab2, { online: true });
  await expectHiddenFrom(tab2, a);
  await expect.poll(async () => {
    const keys = await page.evaluate(() => Object.keys(localStorage));
    return keys.filter((k) => k.endsWith(`.${a.id}`) && /^crm\.call\.(pending|tally)\./.test(k));
  }).toEqual([]);
  await expectNoClientTraces(page, a);
});

test('сессия A истекла, никто не вошёл: возврат на вкладку без события online уводит со «Звонить» и с карточки клиента', async ({ page, context }) => {
  const a = await makeOperator(2, { lpr: true });
  await openCall(page, a);
  await expect(page.getByTestId('call-card')).toContainText(a.names[0]!);
  const tab2 = await context.newPage();
  await tab2.goto(`/clients/${a.clientIds[0]}`);
  await expect(tab2.locator('body')).toContainText('Асель Синтетик');

  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  await returnTo(tab2);
  await expectHiddenFrom(tab2, a);
  await expect(tab2).toHaveURL(/\/login/);
  await returnTo(page);
  await expectHiddenFrom(page, a);
  await expect(page).toHaveURL(/\/login/);
});

type SeedEntry = { opId: string; createdAt: number; freeText: boolean; note: string; lprName: string };

/** Итоги сотрудника, которые он не успел отправить (синтетика): прямо в IndexedDB телефона. */
async function seedOutbox(page: Page, userId: string, cardId: string, entries: SeedEntry[]): Promise<void> {
  await page.evaluate(
    async ({ userId, cardId, entries, now }) => {
      const req = (opId: string, note: string, lprName: string) => ({
        opId, cardId, outcomeKey: 'no_answer', via: 'offline', occurredAt: now, tappedAt: null, phoneId: null, reasonCode: '', note,
        lpr: lprName ? 'no' : '', lprInfo: lprName ? { name: lprName, phone: '+7 709 555 12 34', when: '' } : null,
        callbackAt: null, markTarget: false, alsoDncPhoneIds: [], fields: {}, durationSec: null, agreement: null,
      });
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('crm-call');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('outbox', 'readwrite');
      for (const e of entries) {
        tx.objectStore('outbox').put({
          opId: e.opId, userId, request: req(e.opId, e.note, e.lprName), notBefore: e.createdAt, attempts: 3, retryAt: e.createdAt,
          createdAt: e.createdAt, title: '', kind: 'no_answer', freeText: e.freeText,
        });
      }
      await new Promise((res, rej) => {
        tx.oncomplete = () => res(null);
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    { userId, cardId, entries, now: Date.now() },
  );
}

/** opId всех итогов в outbox телефона. */
function outboxIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('crm-call');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<Array<{ opId: string }>>((res) => {
      const g = db.transaction('outbox').objectStore('outbox').getAll();
      g.onsuccess = () => res(g.result as Array<{ opId: string }>);
    });
    db.close();
    return rows.map((x) => x.opId).sort();
  });
}

type ExpiredMeta = { claimed: { count: number; opIds: string[]; deviceId: string; reason: string }; checked: { authorExists: boolean; alreadyReceived: number } };
const expiredRows = (authorId: string) =>
  sql<{ actorId: string; meta: ExpiredMeta }[]>`
    SELECT actor_id AS "actorId", meta FROM audit_log WHERE action = 'user.outbox_expired' AND entity = 'user' AND entity_id = ${authorId}`;

const HOUR = 3_600_000;

test('итоги A со свободным текстом старше calling.offlineWindowHours удаляются под B и попадают в журнал; свежие и без текста остаются', async ({ page }) => {
  const a = await makeOperator(1);
  const b = await makeOperator(1);
  await openCall(page, a);
  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  await page.goto('/login');
  const ids = { old: randomUUID(), fresh: randomUUID(), bare: randomUUID() };
  const now = Date.now();
  // Итоги A, которые A не успел отправить (синтетика): старый и свежий с ЛПР и заметкой, старый без текста
  await seedOutbox(page, a.id, a.cardIds[0]!, [
    { opId: ids.old, createdAt: now - 100 * HOUR, freeText: true, note: 'Старая заметка Синтетик', lprName: 'Берик Синтетик-ЛПР' },
    { opId: ids.fresh, createdAt: now - HOUR, freeText: true, note: 'Свежая заметка Синтетик', lprName: 'Дана Синтетик-ЛПР' },
    { opId: ids.bare, createdAt: now - 100 * HOUR, freeText: false, note: '', lprName: '' },
  ]);

  await login(page, b);
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
  await expect.poll(() => outboxIds(page), { timeout: 15_000 }).toEqual([ids.fresh, ids.bare].sort());
  const dump = await dumpDevice(page);
  expect(dump).not.toContain('Берик Синтетик-ЛПР');
  expect(dump).not.toContain('Старая заметка Синтетик');
  expect(dump).toContain('Дана Синтетик-ЛПР');
  // Потеря видна: запись журнала о сотруднике A от сотрудника B, без ПДн; заявленное телефоном отделено от проверенного.
  // Переход посреди уборки (здесь — сразу на /call после входа) может повторить сообщение — строка всё равно одна (D-311)
  await expect.poll(async () => (await expiredRows(a.id)).length, { timeout: 15_000 }).toBe(1);
  const rows = await expiredRows(a.id);
  for (const r of rows) {
    expect(r.actorId).toBe(b.id);
    expect(r.meta.claimed.opIds).toEqual([ids.old]);
    expect(r.meta.claimed.reason).toBe('expired');
    expect(r.meta.checked.authorExists).toBe(true);
    expect(JSON.stringify(r.meta)).not.toContain('Синтетик');
  }
  // Повтор загрузки (вторая уборка, событие online) строк не прибавляет
  await page.reload();
  await expect(page.getByTestId('call-card')).toBeVisible();
  expect(await expiredRows(a.id)).toHaveLength(1);
  expect(await callsOf(a.id)).toHaveLength(0);
});

test('D-308: вошёл сотрудник «только чтение», сервер не принял сообщение — ПДн A удалены сразу, потеря в журнале при следующей загрузке', async ({ page, context }) => {
  const a = await makeOperator(1);
  const dir = await makeOperator(0, { role: 'director' });
  await openCall(page, a);
  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  await page.goto('/login');
  const old = randomUUID();
  await seedOutbox(page, a.id, a.cardIds[0]!, [
    { opId: old, createdAt: Date.now() - 100 * HOUR, freeText: true, note: 'Старая заметка Синтетик', lprName: 'Берик Синтетик-ЛПР' },
  ]);

  // Сервер недоступен для сообщения о потере (5xx): ПДн всё равно не остаются на телефоне
  let refused = 0;
  await context.route('**/api/device/outbox-expired', (r) => {
    refused++;
    return r.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await login(page, dir);
  await expect.poll(() => outboxIds(page), { timeout: 15_000 }).toEqual([]);
  expect(refused).toBeGreaterThanOrEqual(1);
  const dump = await dumpDevice(page);
  expect(dump).not.toContain('Берик Синтетик-ЛПР');
  expect(dump).not.toContain('Старая заметка Синтетик');
  expect(dump).not.toContain('555 12 34');
  // След потери ждёт на телефоне: только id
  expect(dump).toContain(old);
  expect(await expiredRows(a.id)).toHaveLength(0);

  // Следующая загрузка: сообщение доходит, роль «только чтение» его не блокирует (мутация безопасности, D-054)
  await context.unroute('**/api/device/outbox-expired');
  await page.reload();
  await expect.poll(async () => (await expiredRows(a.id)).length, { timeout: 15_000 }).toBe(1);
  for (const r of await expiredRows(a.id)) {
    expect(r.actorId).toBe(dir.id);
    expect(r.meta.claimed.opIds).toEqual([old]);
    expect(JSON.stringify(r.meta)).not.toContain('Синтетик');
  }
  await expect.poll(async () => (await dumpDevice(page)).includes(old), { timeout: 15_000 }).toBe(false);
  expect(await callsOf(a.id)).toHaveLength(0);
});

test('D-309: сообщение о потере не дошло под B, следующим вошёл сам A — потеря в журнале (от A о себе) и на экране A', async ({ page, context }) => {
  const a = await makeOperator(1);
  const b = await makeOperator(1);
  await openCall(page, a);
  await sql`DELETE FROM sessions WHERE user_id = ${a.id}`;
  await page.goto('/login');
  const old = randomUUID();
  await seedOutbox(page, a.id, a.cardIds[0]!, [
    { opId: old, createdAt: Date.now() - 100 * HOUR, freeText: true, note: 'Старая заметка Синтетик', lprName: 'Берик Синтетик-ЛПР' },
  ]);

  // Под B сервер не принял сообщение (5xx): итог A удалён, след ждёт на телефоне
  let refused = 0;
  await context.route('**/api/device/outbox-expired', (r) => {
    refused++;
    return r.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await login(page, b);
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
  await expect.poll(() => outboxIds(page), { timeout: 15_000 }).toEqual([]);
  expect(refused).toBeGreaterThanOrEqual(1);
  expect(await dumpDevice(page)).toContain(old);
  expect(await expiredRows(a.id)).toHaveLength(0);

  // Сессия B истекла без перезагрузки, на этот телефон входит сам A: сообщение уходит под A и не выбрасывается
  await context.unroute('**/api/device/outbox-expired');
  await sql`DELETE FROM sessions WHERE user_id = ${b.id}`;
  // Страница B узнаёт об истёкшей сессии и уходит на вход: под B сообщение больше не отправить. Ждём этого, чтобы
  // её переход не оборвал открытие страницы входа
  await page.reload();
  await page.waitForURL((u) => u.pathname === '/login');
  expect(await expiredRows(a.id)).toHaveLength(0);
  await login(page, a);
  await expect.poll(async () => (await expiredRows(a.id)).length, { timeout: 15_000 }).toBe(1);
  const [row] = await expiredRows(a.id);
  expect(row!.actorId).toBe(a.id);
  expect(row!.meta.claimed.opIds).toEqual([old]);
  expect(JSON.stringify(row!.meta)).not.toContain('Синтетик');
  // A видит, что его итог потерян
  await expect(page.getByRole('status').getByText(/1 ваш неотправленный итог удалён с телефона по сроку/)).toBeVisible();
  await expect.poll(async () => (await dumpDevice(page)).includes(old), { timeout: 15_000 }).toBe(false);
  expect(await callsOf(a.id)).toHaveLength(0);
});
