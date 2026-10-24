// Кнопка «Уведомления на телефон» в «Моём аккаунте» (P8b-2, D-328) и отсутствие полосы лицензии при рабочей лицензии
// (P10b; состояния полосы проверяет интеграционный тест на подписанных лицензиях — в сборке e2e ключей владельца нет).
// Push-сервиса в e2e нет: PushManager и Notification подменены; ключи подписки настоящие (сервер проверяет точку кривой).
// Синтетика: +7 709 …
import { createECDH, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DB_URL, login, makeOperator, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(async () => {
  prepareDb();
  // Переключатель администратора и отметка решения клиента (экран «Интеграции» — задача P8b-3)
  const t = Date.now();
  await sql`INSERT INTO push_settings (id, enabled, crossborder_approved_at, crossborder_approved_by, updated_at, updated_by)
            VALUES (1, TRUE, ${t}, NULL, ${t}, NULL)
            ON CONFLICT (id) DO UPDATE SET enabled = TRUE, crossborder_approved_at = ${t}`;
});

const b64u = (b: Buffer) => b.toString('base64url');

test('включить и выключить уведомления на телефоне; полосы лицензии нет', async ({ page }) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) };
  await page.addInitScript((k) => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/synthetic-e2e-account-0001';
    const fake = {
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, keys: k }),
      unsubscribe: async () => {
        sessionStorage.removeItem('e2e-push-on');
        sessionStorage.setItem('e2e-push-unsub', '1');
        return true;
      },
    };
    let permission = 'default';
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => {
      permission = 'granted';
      return 'granted';
    };
    PushManager.prototype.getSubscription = async function () {
      return (sessionStorage.getItem('e2e-push-on') ? fake : null) as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async function () {
      sessionStorage.setItem('e2e-push-on', '1');
      return fake as unknown as PushSubscription;
    };
  }, keys);

  const op = await makeOperator(1);
  await login(page, op);
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
  await expect(page.getByTestId('license-banner')).toHaveCount(0);

  await page.goto('/account');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const block = page.getByTestId('push-toggle');
  await expect(block).toBeVisible();
  const subscribe = page.waitForResponse((r) => r.url().includes('/api/push/subscribe'));
  await block.getByRole('button', { name: 'Включить уведомления' }).click();
  expect((await subscribe).status()).toBe(200);
  await expect(block.getByRole('status')).toContainText('Уведомления включены');

  const [row] = await sql<{ sessionId: string | null; disabledAt: string | null }[]>`
    SELECT session_id AS "sessionId", disabled_at AS "disabledAt" FROM push_subscriptions WHERE user_id = ${op.id}`;
  expect(row?.sessionId).toMatch(/^[0-9a-f]{64}$/);
  expect(row?.disabledAt).toBeNull();

  await block.getByRole('button', { name: 'Выключить уведомления' }).click();
  await expect(block.getByRole('button', { name: 'Включить уведомления' })).toBeVisible();
  await expect.poll(async () => (await sql<{ d: string | null }[]>`SELECT disabled_at AS d FROM push_subscriptions WHERE user_id = ${op.id}`)[0]?.d).not.toBeNull();
});

test('после «Выйти на всех устройствах» и нового входа подписка привязана к новой сессии', async ({ page }) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) };
  // Разрешение и подписка живут в sessionStorage: переживают выход и новый вход в той же вкладке, как в браузере
  await page.addInitScript((k) => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/synthetic-e2e-account-0002';
    const fake = {
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, keys: k }),
      unsubscribe: async () => {
        sessionStorage.removeItem('e2e-push-on');
        return true;
      },
    };
    Object.defineProperty(Notification, 'permission', { get: () => sessionStorage.getItem('e2e-push-perm') ?? 'default' });
    Notification.requestPermission = async () => {
      sessionStorage.setItem('e2e-push-perm', 'granted');
      return 'granted';
    };
    PushManager.prototype.getSubscription = async function () {
      return (sessionStorage.getItem('e2e-push-on') ? fake : null) as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async function () {
      sessionStorage.setItem('e2e-push-on', '1');
      return fake as unknown as PushSubscription;
    };
  }, keys);
  const row = async () =>
    (await sql<{ sessionId: string | null; disabledAt: string | null }[]>`
      SELECT session_id AS "sessionId", disabled_at AS "disabledAt" FROM push_subscriptions WHERE user_id = ${op.id}`)[0];
  const liveSessions = async () => (await sql<{ id: string }[]>`SELECT id FROM sessions WHERE user_id = ${op.id}`).map((r) => r.id);

  const op = await makeOperator(1);
  await login(page, op);
  // Оболочка (service worker) регистрируется на рабочем экране; при OP_BOARD вход ведёт на доску и регистрация идёт
  // позже загрузки очереди, поэтому сначала открываем /call, как в первом тесте файла
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
  await page.goto('/account');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const block = page.getByTestId('push-toggle');
  await block.getByRole('button', { name: 'Включить уведомления' }).click();
  await expect(block.getByRole('status')).toContainText('Уведомления включены');
  const first = (await row())?.sessionId;
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  // Обычная работа после включения: оболочка рабочих экранов сверяет привязку (повторная привязка, если она
  // случится, успевает закончиться до выхода)
  const checked = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/push');
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
  await checked;
  await page.waitForResponse((r) => r.url().includes('/api/push/subscribe'), { timeout: 3_000 }).catch(() => null);
  expect((await row())?.sessionId).toBe(first);

  // «Выйти на всех устройствах»: сессия удалена, подписка в браузере осталась (это не обычный «Выйти»)
  await page.goto('/account');
  await page.getByRole('button', { name: 'Выйти на всех устройствах' }).click();
  await page.getByRole('button', { name: 'Выйти на всех устройствах' }).last().click();
  await page.waitForURL(/\/login/);
  expect(await liveSessions()).toEqual([]);

  await login(page, op);
  const [second] = await liveSessions();
  expect(second).toBeDefined();
  expect(second).not.toBe(first);
  await expect.poll(async () => (await row())?.sessionId, { message: 'подписка перепривязана к новой сессии' }).toBe(second);
  expect((await row())?.disabledAt).toBeNull();

  await page.goto('/account');
  await expect(page.getByTestId('push-toggle').getByRole('status')).toContainText('Уведомления включены');
});
