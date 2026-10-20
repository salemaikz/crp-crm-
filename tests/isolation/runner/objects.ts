// Объекты оператора B для прогона: по сущности охвата — id чужого объекта и клиент, чьи название,
// номер и БИН не должны попасть в ответ оператора A. Новая сущность в SCOPED_ENTITIES без записи
// здесь не пройдёт typecheck: сначала синтетика, потом манифест.
import type { ScopedEntity } from '../../../src/server/access/types';
import type { Sql } from '../../../src/server/platform/db';
import { FX, SEED_NOW, SPACE, U, cardOf, clientOf } from '../harness/seed';
import { nameNeedle, phoneNeedle, type Needle } from './checks';

type Foreign = { id: string; client: string };
const B1 = clientOf('b', 1);

/** Объект оператора B по сущности (ids из tests/isolation/harness/seed.ts и markFixtures). */
export const FOREIGN: Readonly<Record<ScopedEntity, Foreign>> = {
  card: { id: cardOf('b', 1), client: B1 },
  client: { id: B1, client: B1 },
  contact: { id: 'ct-b-1', client: B1 },
  client_phone: { id: 'ph-b-1', client: B1 },
  deal: { id: 'dl-b-1', client: B1 },
  booking: { id: FX.bkInWindow.booking, client: FX.bkInWindow.client },
  call: { id: 'call-b-1', client: B1 },
  note: { id: 'nt-b-1', client: B1 },
  client_event: { id: 'ce-b-1', client: B1 },
  task: { id: 'tk-b-1', client: B1 },
  handoff: { id: FX.handoffLive.handoff, client: FX.handoffLive.client },
  messenger_chat: { id: 'chat-b1', client: B1 },
  event: { id: FX.eventToday.event, client: FX.eventToday.client },
};

/** Синтетический БИН клиента B{i}: 12 цифр, не пересекается с номерами. */
export const binOf = (i: number) => `9901003${String(i).padStart(5, '0')}`;

/** Дополнить синтетику P4a тем, что нужно прогону: БИН клиентов B, контакт B1. Идемпотентно. */
export async function markFixtures(sql: Sql): Promise<void> {
  for (let i = 1; i <= 9; i++) await sql`UPDATE clients SET org_id = ${binOf(i)} WHERE id = ${clientOf('b', i)} AND org_id = ''`;
  await sql`INSERT INTO contacts (id, client_id, name, position, created_at)
            VALUES ('ct-b-1', ${B1}, 'Контакт Синтетик Бетович', 'Директор', ${SEED_NOW})
            ON CONFLICT (id) DO NOTHING`;
}

/** Иглы клиентов: название, БИН, номера, имена контактов. */
export async function clientNeedles(sql: Sql, clientIds: readonly string[]): Promise<Needle[]> {
  const needles: Needle[] = [];
  const clients = await sql<{ name: string; orgId: string }>`SELECT name, org_id FROM clients WHERE id = ANY(${clientIds as string[]})`;
  for (const c of clients) {
    needles.push(nameNeedle(c.name));
    if (c.orgId) needles.push(c.orgId);
  }
  const phones = await sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = ANY(${clientIds as string[]})`;
  for (const p of phones) needles.push(phoneNeedle(p.digits));
  const contacts = await sql<{ name: string }>`SELECT name FROM contacts WHERE client_id = ANY(${clientIds as string[]}) AND name <> ''`;
  for (const c of contacts) needles.push(nameNeedle(c.name));
  return needles;
}

/** Иглы одного чужого объекта (его клиента). */
export const needlesOf = (sql: Sql, entity: ScopedEntity): Promise<Needle[]> => clientNeedles(sql, [FOREIGN[entity].client]);

/** Иглы всех клиентов, у которых есть карточки оператора B (для разделов без id). */
export async function allForeignNeedles(sql: Sql): Promise<Needle[]> {
  const rows = await sql<{ clientId: string }>`SELECT DISTINCT client_id FROM cards WHERE owner_user_id = ${U.opB} AND space_id = ${SPACE}`;
  return clientNeedles(sql, rows.map((r) => r.clientId));
}
