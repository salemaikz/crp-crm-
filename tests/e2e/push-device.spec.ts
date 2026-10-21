// Web-push на общем телефоне (D-328): выход снимает подписку push в браузере первым делом, а после входа без
// разрешения на уведомления страница ничего не подписывает сама. Push-сервиса в e2e нет: PushManager подменён
// заглушкой, которая считает снятия подписки в sessionStorage (переживает переход на вход). Синтетика: +7 709 …
import { expect, test } from '@playwright/test';
import { DB_URL, makeOperator, openCall, prepareDb } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

test('выход снимает подписку push этого устройства; без разрешения подписка не создаётся', async ({ page }) => {
  await page.addInitScript(() => {
    const KEY = 'e2e-push-unsub';
    const fake = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-e2e-0001',
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-e2e-0001', keys: {} }),
      unsubscribe: async () => {
        sessionStorage.setItem(KEY, String(Number(sessionStorage.getItem(KEY) ?? '0') + 1));
        return true;
      },
    };
    if ('PushManager' in window) {
      PushManager.prototype.getSubscription = async function () {
        return (sessionStorage.getItem(KEY) ? null : fake) as unknown as PushSubscription;
      };
      PushManager.prototype.subscribe = async function () {
        sessionStorage.setItem('e2e-push-subscribed', '1');
        return fake as unknown as PushSubscription;
      };
    }
  });
  const subscribeCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/push/subscribe')) subscribeCalls.push(r.method());
  });
  const op = await makeOperator(1);
  await openCall(page, op);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.getByTestId('call-card')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('e2e-push-subscribed'))).toBeNull();
  expect(subscribeCalls, 'без разрешения на уведомления привязки нет').toEqual([]);

  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login/);
  expect(await page.evaluate(() => sessionStorage.getItem('e2e-push-unsub'))).toBe('1');
});
