// Режимы каналов (D-268): кнопки «Позвонить» на экране «Звонить» и в карточке клиента ведут в звонилку телефона
// (tel:), пока нет пригодной телефонии провайдера. Подключение Beeline при выключенном в production флаге
// FEATURE_TELEPHONY_BEELINE режим не меняет. Только синтетика (+7 709 …).
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DB_URL, login, makeOperator, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

test('tel: в карточке клиента и на «Звонить»; включённая Beeline за выключенным флагом — всё равно tel:', async ({ page }) => {
  const op = await makeOperator(1);
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const integrationId = randomUUID();
  const t = Date.now();
  await sql`INSERT INTO integrations (id, plugin_id, space_id, enabled, created_at, updated_at)
            VALUES (${integrationId}, 'telephony.beeline', ${space!.id}, TRUE, ${t}, ${t})`;
  try {
    await login(page, op);
    await page.goto(`/clients/${op.clientIds[0]}`);
    const cardCall = page.locator('a[href^="tel:"]').first();
    await expect(cardCall).toHaveAttribute('href', /^tel:\+7709\d{7}$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.goto('/call');
    await expect(page.getByTestId('call-button')).toHaveAttribute('href', /^tel:\+7709\d{7}$/);
  } finally {
    await sql`DELETE FROM integrations WHERE id = ${integrationId}`;
  }
});
