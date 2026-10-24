// Сид круга 3 для сценариев доски: покупки с вариантом, закрытые карточки, плитки с тоном. Только синтетика (+7 709 …).
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext } from '@playwright/test';
import { loginByRequest, makeOperator, sql, type Operator } from './calling';
import { makeAgreed } from './board';

/** Контекст браузера с входом РОП (отдельная сессия: покупку и явку оператор сам не регистрирует). Закрывать `close()`. */
export async function ropContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const rop = await makeOperator(0, { role: 'rop' });
  const ctx = await browser.newContext({ baseURL });
  await loginByRequest(ctx, rop, baseURL);
  return ctx;
}

/**
 * Покупка с вариантом услуги через API (`POST /api/deals/purchase`, РОП): сервер сам проверяет вариант и пишет `deal.won`.
 * Карточка оператора `op` в «Договорились» с открытой сделкой сеется SQL (база сценария); заслуга остаётся у `op`.
 */
export async function makeWonDealVariant(rop: BrowserContext, op: Operator, amount: number, service = 'celina', variant = 'online'): Promise<{ name: string; cardId: string; dealId: string }> {
  const [c] = await makeAgreed(op, 1);
  const res = await rop.request.post('/api/deals/purchase', {
    headers: { origin: process.env.APP_ORIGIN ?? `http://localhost:${process.env.E2E_PORT || 3100}`, 'content-type': 'application/json' },
    data: { requestId: randomUUID(), cardId: c!.cardId, dealId: c!.dealId, serviceTypeKey: service, variantKey: variant, amountKzt: amount, wonDay: null },
  });
  if (res.status() !== 201) throw new Error(`покупка не записана: ${res.status()} ${await res.text()}`);
  return { name: c!.name, cardId: c!.cardId, dealId: c!.dealId };
}

/** Карточки оператора, закрытые с причиной (`state` — вид итога, `reason` — код причины из настроек). */
export async function makeTrash(op: Operator, n: number, state = 'not_target', reason = 'company_closed'): Promise<string[]> {
  const ids = op.cardIds.slice(0, n);
  const t = Date.now();
  for (const id of ids) await sql`UPDATE cards SET state = ${state}, close_reason_code = ${reason}, closed_at = ${t - 3_600_000}, updated_at = ${t} WHERE id = ${id}`;
  return op.names.slice(0, n);
}
