// Сценарии доски оператора, этап В: карточки «Договорились» с записью, выигранные сделки и жесты касания.
// Только синтетика (+7 709 …, «ТОО Синтетика …»). БД - E2E_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from '@playwright/test';
import { sql, type Operator } from './calling';
import { uniquePhone } from './phones';

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');

export interface AgreedCard {
  cardId: string;
  clientId: string;
  bookingId: string;
  dealId: string;
  name: string;
}

export interface AgreedOptions {
  /** Вид записи (`booking.eventTypes[].key`); группа - по умолчанию. */
  type?: string;
  /** Мероприятие началось столько мс назад (отрицательное - ещё не началось); не раньше начала местных суток. */
  startedAgoMs?: number;
}

/** Мероприятие сегодня (UTC+5) и `n` карточек пользователя в «Договорились» с записью открытой сделки. */
export async function makeAgreed(op: Operator, n: number, opts: AgreedOptions = {}): Promise<AgreedCard[]> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  if (!space) throw new Error('нет пространства sales');
  const t = Date.now();
  const type = opts.type ?? 'br';
  const localMidnight = Math.floor((t + 5 * 3_600_000) / 86_400_000) * 86_400_000 - 5 * 3_600_000;
  const startsAt = opts.startedAgoMs !== undefined && opts.startedAgoMs < 0 ? t - opts.startedAgoMs : Math.max(t - (opts.startedAgoMs ?? 3_600_000), localMidnight);
  const stamp = new Date(startsAt + 5 * 3_600_000).toISOString();
  const eventId = randomUUID();
  await sql`
    INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, occurrence_key, touched, created_at, updated_at)
    VALUES (${eventId}, ${space.id}, NULL, ${type}, ${stamp.slice(0, 10)}, ${stamp.slice(11, 16)}, ${startsAt}, 180, 'Зал 1', 'offline', 30, 'scheduled', NULL, FALSE, ${t}, ${t})`;
  const tag = digits(5);
  const out: AgreedCard[] = [];
  for (let i = 1; i <= n; i++) {
    const c: AgreedCard = { cardId: randomUUID(), clientId: randomUUID(), bookingId: randomUUID(), dealId: randomUUID(), name: `ТОО Синтетика ${tag} №${i}` };
    await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
              VALUES (${c.clientId}, 'company', ${c.name}, ${c.name.toLowerCase()}, ${c.name.toLowerCase()}, 'import', ${t}, ${t})`;
    await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${randomUUID()}, ${c.clientId}, ${await uniquePhone(sql)}, 'mobile', TRUE, ${t})`;
    await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
              VALUES (${c.cardId}, ${space.id}, ${c.clientId}, ${op.id}, 'agreed', ${t}, ${t + i}, ${t})`;
    await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
              VALUES (${c.dealId}, ${space.id}, 'sales', 'booked', 'open', ${c.clientId}, ${c.cardId}, ${op.id}, ${t}, ${t}, ${t})`;
    await sql`
      INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, status,
                            booked_by_user_id, responsible_user_id, version, created_at, updated_at)
      VALUES (${c.bookingId}, ${space.id}, 'group', ${type}, ${eventId}, ${c.clientId}, ${c.cardId}, ${c.dealId}, ${stamp.slice(0, 10)}, ${stamp.slice(11, 16)}, ${startsAt}, 180,
              'registered', ${op.id}, ${op.id}, 0, ${t}, ${t})`;
    out.push(c);
  }
  return out;
}

/** Выигранная сделка (засчитана `userId` по первой записи) на сумму `amount` тенге в текущем месяце. */
export async function makeWonDeal(userId: string, amount: number): Promise<{ name: string }> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const t = Date.now();
  const clientId = randomUUID();
  const cardId = randomUUID();
  const dealId = randomUUID();
  const name = `ТОО Синтетика ${digits(5)} покупка`;
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${clientId}, 'company', ${name}, ${name.toLowerCase()}, ${name.toLowerCase()}, 'import', ${t}, ${t})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
            VALUES (${cardId}, ${space!.id}, ${clientId}, ${userId}, 'client', ${t}, ${t}, ${t})`;
  await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, stage_changed_at, created_at, updated_at)
            VALUES (${dealId}, ${space!.id}, 'sales', 'offer', 'won', ${clientId}, ${cardId}, ${userId}, 'celina', ${amount}, ${t}, ${t}, ${t}, ${t})`;
  await sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, status,
                          booked_by_user_id, responsible_user_id, version, created_at, updated_at)
    VALUES (${randomUUID()}, ${space!.id}, 'individual', 'bk', ${clientId}, ${cardId}, ${dealId}, '2026-10-01', '10:00', ${t - 86_400_000}, 60, 'attended', ${userId}, ${userId}, 0, ${t - 86_400_000}, ${t})`;
  return { name };
}

// Один сеанс CDP на страницу: состояние касания живёт между вызовами жеста
const sessions = new WeakMap<Page, CDPSession>();

interface Pt {
  x: number;
  y: number;
}

/**
 * Жест пальцем по шагам. Chromium - настоящие события касания через CDP (прокрутка страницы остаётся браузерной);
 * WebKit - те же события, посланные страницей (CDP там нет): проверяется наша обработка жеста, а не движок прокрутки.
 */
export async function touchGesture(page: Page, browserName: string, steps: Array<{ type: 'start' | 'move' | 'end'; at: Pt; waitMs?: number }>): Promise<void> {
  if (browserName === 'chromium') {
    let cdp = sessions.get(page);
    if (!cdp) {
      cdp = await page.context().newCDPSession(page);
      sessions.set(page, cdp);
    }
    for (const s of steps) {
      if (s.waitMs) await page.waitForTimeout(s.waitMs);
      await cdp.send('Input.dispatchTouchEvent', {
        type: s.type === 'start' ? 'touchStart' : s.type === 'move' ? 'touchMove' : 'touchEnd',
        touchPoints: s.type === 'end' ? [] : [{ x: s.at.x, y: s.at.y, id: 1 }],
      });
    }
    return;
  }
  for (const s of steps) {
    if (s.waitMs) await page.waitForTimeout(s.waitMs);
    await page.evaluate(
      ({ type, at }) => {
        const touch = { identifier: 1, clientX: at.x, clientY: at.y, pageX: at.x, pageY: at.y, screenX: at.x, screenY: at.y, target: document.body };
        const target: EventTarget = type === 'start' ? (document.elementFromPoint(at.x, at.y) ?? document.body) : window;
        const e = new Event(type === 'start' ? 'touchstart' : type === 'move' ? 'touchmove' : 'touchend', { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'touches', { value: type === 'end' ? [] : [touch] });
        Object.defineProperty(e, 'changedTouches', { value: [touch] });
        target.dispatchEvent(e);
      },
      { type: s.type, at: s.at },
    );
  }
}

/** Шторка «Фильтры» на телефоне открыта (на ноутбуке фильтры стоят в шапке и шторки нет). */
export async function openFilters(page: Page): Promise<void> {
  const open = page.getByTestId('board-filters-open');
  if (await open.count()) await open.click();
}

/** Закрыть шторку «Фильтры» кнопкой «Готово»; на ноутбуке ничего не делает. */
export async function closeFilters(page: Page): Promise<void> {
  const done = page.getByTestId('filters-done');
  if (await done.count()) await done.click();
}

/** Выбрать сотрудника на доске пространства (РОП, директор): через шторку на телефоне и из шапки на ноутбуке. */
export async function pickOwner(page: Page, userId: string): Promise<void> {
  await openFilters(page);
  await page.getByTestId('filter-owner').selectOption(userId);
  await closeFilters(page);
}
