// Сид круга 3 для сценариев доски: покупки с вариантом, закрытые карточки, плитки с тоном. Только синтетика (+7 709 …).
import { randomUUID } from 'node:crypto';
import { sql, type Operator } from './calling';
import { uniquePhone } from './phones';

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');

/** Выигранная сделка с вариантом услуги; карточка клиента — в состоянии «клиент» у `userId`. */
export async function makeWonDealVariant(userId: string, amount: number, service = 'celina', variant = 'online'): Promise<{ name: string; cardId: string; dealId: string }> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const t = Date.now();
  const clientId = randomUUID();
  const cardId = randomUUID();
  const dealId = randomUUID();
  const name = `ТОО Синтетика ${digits(5)} покупка`;
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${clientId}, 'company', ${name}, ${name.toLowerCase()}, ${name.toLowerCase()}, 'import', ${t}, ${t})`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${randomUUID()}, ${clientId}, ${await uniquePhone(sql)}, 'mobile', TRUE, ${t})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
            VALUES (${cardId}, ${space!.id}, ${clientId}, ${userId}, 'client', ${t}, ${t}, ${t})`;
  await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, service_variant_key, amount_kzt, won_at, stage_changed_at, created_at, updated_at)
            VALUES (${dealId}, ${space!.id}, 'sales', 'offer', 'won', ${clientId}, ${cardId}, ${userId}, ${service}, ${variant}, ${amount}, ${t}, ${t}, ${t}, ${t})`;
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, status,
                                  booked_by_user_id, responsible_user_id, version, created_at, updated_at)
            VALUES (${randomUUID()}, ${space!.id}, 'individual', 'bk', ${clientId}, ${cardId}, ${dealId}, '2026-10-01', '10:00', ${t - 86_400_000}, 60, 'attended', ${userId}, ${userId}, 0, ${t - 86_400_000}, ${t})`;
  return { name, cardId, dealId };
}

/** Карточки оператора, закрытые с причиной (`state` — вид итога, `reason` — код причины из настроек). */
export async function makeTrash(op: Operator, n: number, state = 'not_target', reason = 'company_closed'): Promise<string[]> {
  const ids = op.cardIds.slice(0, n);
  const t = Date.now();
  for (const id of ids) await sql`UPDATE cards SET state = ${state}, close_reason_code = ${reason}, closed_at = ${t - 3_600_000}, updated_at = ${t} WHERE id = ${id}`;
  return op.names.slice(0, n);
}
