// Одноразовые билеты полной выгрузки (D-264): 32 байта CSPRNG, живут 60 с в памяти процесса; хранится только sha256
// билета. Приложение работает одним процессом (ARCHITECTURE §8.1), поэтому памяти процесса достаточно; перезапуск
// гасит все билеты — пользователь просто вводит пароль ещё раз.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TICKET_TTL_MS = 60_000;
export const TICKETS_MAX = 100;

type Entry = { userId: string; expiresAt: number };
type Store = Map<string, Entry>;
const g = globalThis as typeof globalThis & { __crmExportTickets?: Store };
const store: Store = (g.__crmExportTickets ??= new Map());

const digest = (ticket: string): string => createHash('sha256').update(ticket, 'utf8').digest('hex');

/** Выдать билет сотруднику. Просроченные вычищаются; при переполнении уходят самые старые. */
export function issueTicket(userId: string, now: number): { ticket: string; expiresAt: number } {
  for (const [k, e] of store) if (e.expiresAt <= now) store.delete(k);
  while (store.size >= TICKETS_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = now + TICKET_TTL_MS;
  store.set(digest(ticket), { userId, expiresAt });
  return { ticket, expiresAt };
}

const sameUser = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Годен ли билет, не гася его: свой и не просроченный. Нужен, чтобы ответ «занято» не сжигал билет (D-294):
 * проверка, захват семафора и погашение идут подряд без await — между ними чужой запрос не вклинится.
 */
export function ticketValid(ticket: string, userId: string, now: number): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
  const e = store.get(digest(ticket));
  return e !== undefined && sameUser(e.userId, userId) && e.expiresAt > now;
}

/**
 * Бронь выгрузки (D-294): живой билет другого сотрудника. Пароль введён — 60 с выгрузка за ним, иначе его шаг 2
 * мог бы получить «занято» от того, кто ввёл пароль позже.
 */
export function heldByOther(userId: string, now: number): boolean {
  for (const e of store.values()) if (e.expiresAt > now && !sameUser(e.userId, userId)) return true;
  return false;
}

/**
 * Погасить билет: удаляется сразу, при любом исходе проверки. Годен — только свой и не просроченный. Вход
 * проверяется по форме до хэширования (чужая строка любой длины не нагружает процесс).
 */
export function consumeTicket(ticket: string, userId: string, now: number): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
  const key = digest(ticket);
  const e = store.get(key);
  if (!e) return false;
  store.delete(key);
  return sameUser(e.userId, userId) && e.expiresAt > now;
}

/** Только тесты: сбросить билеты. */
export function resetTicketsForTests(): void {
  store.clear();
}

export function ticketCount(): number {
  return store.size;
}
