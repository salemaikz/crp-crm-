// Офлайн-итоги: без сети итоги копятся на телефоне, с возвратом сети уходят без дублей (ARCHITECTURE §7, D-063).
import { expect, test } from '@playwright/test';
import { DB_URL, callAndOutcome, callsOf, cardTitle, makeOperator, openCall, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});
// Соединение с БД общее для файлов сценариев (один рабочий процесс): закроется вместе с процессом

test('без сети 5 итогов → сеть вернулась → 5 строк на сервере без дублей', async ({ page, context }) => {
  const op = await makeOperator(9);
  const pendingHeaders: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/calls/queue')) void r.allHeaders().then((h) => pendingHeaders.push(h['x-outbox-pending'] ?? ''));
  });
  await openCall(page, op);
  await expect(cardTitle(page)).toHaveText(op.names[0]!);

  await context.setOffline(true);
  for (let i = 0; i < 5; i++) {
    await expect(cardTitle(page)).toHaveText(op.names[i]!);
    await callAndOutcome(page, 'no_answer');
  }
  await expect(page.getByTestId('call-today')).toContainText('5 итогов');
  // Окно отмены прошло, сети нет: внизу «Не отправлено», на сервере пусто
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 5', { timeout: 15_000 });
  expect(await callsOf(op.id)).toHaveLength(0);
  // Данные для сводки руководителя лежат в IndexedDB устройства, не на сервере
  const stored = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('crm-call');
        req.onsuccess = () => {
          const all = req.result.transaction('outbox').objectStore('outbox').getAll();
          all.onsuccess = () => resolve(all.result.length);
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  expect(stored).toBe(5);

  await context.setOffline(false);
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(5);
  await expect(page.getByTestId('outbox-banner')).toBeHidden({ timeout: 20_000 });

  const rows = await callsOf(op.id);
  expect(new Set(rows.map((r) => r.id)).size).toBe(5);
  expect(rows.map((r) => r.cardId).sort()).toEqual(op.cardIds.slice(0, 5).sort());
  expect(rows.every((r) => r.applied === 'applied' && r.via === 'offline')).toBe(true);
  const feed = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'call' AND actor_id = ${op.id}`;
  expect(feed[0]!.n).toBe(5);

  // Повторный заход на экран: очередь без обработанных, ничего не уходит второй раз
  await page.reload();
  await expect(cardTitle(page)).toHaveText(op.names[5]!);
  await page.waitForTimeout(2_000);
  expect(await callsOf(op.id)).toHaveLength(5);

  // Заголовок X-Outbox-Pending ходит с запросами очереди; в конце неотправленных нет (D-063)
  expect(pendingHeaders.length).toBeGreaterThan(0);
  expect(pendingHeaders.every((v) => /^\d+$/.test(v))).toBe(true);
  await expect
    .poll(async () => (await sql<{ p: number }[]>`SELECT pending_outbox AS p FROM device_status WHERE user_id = ${op.id}`)[0]?.p, { timeout: 20_000 })
    .toBe(0);
});

test('выгрузка вкладки с неотправленными итогами: после перезапуска они уходят', async ({ page, context }) => {
  const op = await makeOperator(5);
  await openCall(page, op);
  await context.setOffline(true);
  await callAndOutcome(page, 'no_answer');
  await callAndOutcome(page, 'no_answer');
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 2', { timeout: 15_000 });
  await context.setOffline(false);
  await page.goto('about:blank');
  await page.goto('/call');
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(2);
});

test('карточку передали, пока оператор был без сети: итог принят фактом, у нового владельца ничего не меняется', async ({ page, context }) => {
  const op = await makeOperator(3);
  const other = await makeOperator(0);
  const cardId = op.cardIds[0]!;
  await sql`INSERT INTO assign_log (id, space_id, card_id, to_user_id, kind, counts_to_cap, day, created_at)
            SELECT gen_random_uuid()::text, space_id, id, ${op.id}, 'auto', FALSE, to_char(now(), 'YYYY-MM-DD'), ${Date.now() - 3_600_000} FROM cards WHERE id = ${cardId}`;
  await openCall(page, op);
  await context.setOffline(true);
  await callAndOutcome(page, 'no_answer');
  await page.waitForTimeout(50);
  // Пока телефон офлайн, карточку передали другому оператору
  await sql`UPDATE cards SET owner_user_id = ${other.id}, version = version + 1 WHERE id = ${cardId}`;
  await sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, actor_id, created_at)
            SELECT gen_random_uuid()::text, space_id, id, ${op.id}, ${other.id}, 'transfer', FALSE, to_char(now(), 'YYYY-MM-DD'), ${other.id}, ${Date.now()} FROM cards WHERE id = ${cardId}`;
  await context.setOffline(false);
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
  const [call] = await sql<{ applied: string; reason: string }[]>`SELECT applied, fact_reason AS reason FROM calls WHERE user_id = ${op.id}`;
  expect(call).toEqual({ applied: 'fact_only', reason: 'owner_changed' });
  const [card] = await sql<{ state: string; attempts: number; owner: string }[]>`SELECT state, attempts, owner_user_id AS owner FROM cards WHERE id = ${cardId}`;
  expect(card).toEqual({ state: 'new', attempts: 0, owner: other.id });
});
