// Общее для тестов доски (C5): мир с настоящим пресетом первого клиента (колонки, веса, роли), чистый лист оператора A,
// добавление карточек. Синтетика: номера +7 709 …, названия выдуманы.
import { register } from 'node:module';
import { calling } from '@crm/core';
import { dueBoundsAt } from '../../../src/server/domain/calls/dueBounds';
import { loadCallingContext } from '../../../src/server/domain/cards/settings';
import type { Sql } from '../../../src/server/platform/db';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { closeWorld, openWorld } from '../access/world';
import { applySeedConfig } from '../../isolation/harness/config';
import { SEED_NOW, SPACE } from '../../isolation/harness/seed';

// Хуки next/headers для вызова route-обработчиков (как у прогона изоляции)
register('../../isolation/runner/hooks.mjs', import.meta.url);

export { SEED_NOW, SPACE };
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Мир с настройками пресета ЦРП в БД. */
export async function openBoardWorld(): Promise<TestDb> {
  // Без NODE_ENV флаги выключены (fail closed): доска и перезвон v2 включаются явно, как на стенде
  process.env['FEATURE_OP_BOARD'] = '1';
  process.env['FEATURE_CALLBACK_V2'] = '1';
  const db = await openWorld();
  await applySeedConfig();
  return db;
}

export async function closeBoardWorld(db: TestDb): Promise<void> {
  delete process.env['FEATURE_OP_BOARD'];
  delete process.env['FEATURE_CALLBACK_V2'];
  resetConfigCache();
  await closeWorld(db);
}

/** Чистый лист: все карточки владельца закрыты без даты закрытия — на доске их нет (окно «Мусора» требует closed_at). */
export async function clearOwner(sql: Sql, owner: string): Promise<void> {
  await sql`UPDATE cards SET state = 'written_off', closed_at = NULL, heat = 0, next_call_at = NULL WHERE owner_user_id = ${owner}`;
}

export interface NewCard {
  id: string;
  owner: string | null;
  state: string;
  heat?: number;
  nextCallAt?: number | null;
  attempts?: number;
  name?: string;
  holdReason?: string;
  closedAt?: number | null;
  lastPurchaseAt?: number | null;
  purchasesTotal?: number;
  assignedAt?: number | null;
}

/** Новая карточка с новым клиентом и рабочим мобильным номером +7 709 … */
export async function addCard(sql: Sql, c: NewCard, phoneSeq = 0): Promise<void> {
  const t = SEED_NOW - DAY;
  const name = c.name ?? `ТОО Синтетика Доска ${c.id}`;
  const digits = `7709${String(8_000_000 + phoneSeq).padStart(7, '0')}`;
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${`cl-${c.id}`}, 'company', ${name}, ${name.toLowerCase()}, ${`${name.toLowerCase()} ${digits}`}, 'import', ${t}, ${t})`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
            VALUES (${`ph-${c.id}`}, ${`cl-${c.id}`}, ${digits}, 'mobile', TRUE, ${t})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, heat, next_call_at, attempts, hold_reason, closed_at,
                               last_purchase_at, purchases_total, assigned_at, created_at, updated_at)
            VALUES (${c.id}, ${SPACE}, ${`cl-${c.id}`}, ${c.owner}, ${c.state}, ${c.heat ?? 0}, ${c.nextCallAt ?? null}, ${c.attempts ?? 0},
                    ${c.holdReason ?? ''}, ${c.closedAt ?? null}, ${c.lastPurchaseAt ?? null}, ${c.purchasesTotal ?? 0}, ${c.assignedAt === undefined ? t : c.assignedAt}, ${t}, ${t})`;
}

/** Границы просрочки «сейчас» прогона: те же, что считает сервер доски. */
export async function boundsNow(): Promise<calling.DueBounds> {
  const ctx = await loadCallingContext(SPACE, SEED_NOW);
  return dueBoundsAt(SEED_NOW, ctx.overdueAlertMinutes, ctx.calendar);
}

/** Детерминированный генератор чисел для сценариев (чтобы падение воспроизводилось). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
