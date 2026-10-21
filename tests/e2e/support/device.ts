// Что лежит на телефоне после выхода (D-063, D-291): localStorage, ВСЕ базы и хранилища IndexedDB, Cache Storage.
// Ищем следы клиентов: цифры номеров как они лежат в БД (7709…), названия, имя ЛПР. Только синтетика.
import { expect, type Page } from '@playwright/test';
import { sql, type Operator } from './calling';

/** Вся клиентская память страницы одной строкой: ключ=значение, база/хранилище=строки, кэш:адрес=тело. */
export async function dumpDevice(page: Page): Promise<string> {
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
        out.push(`idb:${info.name}/${name}=${JSON.stringify(rows)}`);
      }
      db.close();
    }
    for (const cn of await caches.keys()) {
      const c = await caches.open(cn);
      for (const r of await c.keys()) out.push(`cache:${cn}:${r.url}=${await (await c.match(r))!.text()}`);
    }
    return out.join('\n');
  });
}

/** Номера клиентов оператора и его ЛПР в том виде, в каком они лежат в БД и в хранилище устройства (7709…). */
export async function clientPhoneDigits(op: Operator): Promise<string[]> {
  const rows = await sql<{ digits: string }[]>`SELECT digits FROM client_phones WHERE client_id = ANY(${op.clientIds})`;
  expect(rows.length).toBeGreaterThanOrEqual(op.clientIds.length);
  return rows.map((r) => r.digits);
}

/** Следов клиентов оператора на устройстве нет: ни названий, ни цифр номеров (11 цифр и без кода страны), ни имени ЛПР. */
export async function expectNoClientTraces(page: Page, op: Operator): Promise<void> {
  const dump = await dumpDevice(page);
  for (const name of op.names) expect(dump, `название «${name}»`).not.toContain(name);
  for (const d of await clientPhoneDigits(op)) {
    expect(dump, `номер ${d}`).not.toContain(d);
    expect(dump, `номер без кода страны ${d.slice(1)}`).not.toContain(d.slice(1));
  }
  expect(dump).not.toContain('Асель Синтетик');
  expect(dump).not.toMatch(new RegExp(`^ls:crm\\.call\\.(pending|tally)\\.${op.id}`, 'm'));
}

export const sessionsOf = async (userId: string): Promise<number> =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`)[0]!.n;

/** Итоги по карточкам оператора от любого сотрудника (проверка, что чужой итог не записан под другой сессией). */
export async function callsOnCards(cardIds: string[]): Promise<Array<{ userId: string; cardId: string }>> {
  return sql<Array<{ userId: string; cardId: string }>>`SELECT user_id AS "userId", card_id AS "cardId" FROM calls WHERE card_id = ANY(${cardIds})`;
}
