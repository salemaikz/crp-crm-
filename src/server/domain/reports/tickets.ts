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
  const a = Buffer.from(e.userId, 'utf8');
  const b = Buffer.from(userId, 'utf8');
  const same = a.length === b.length && timingSafeEqual(a, b);
  return same && e.expiresAt > now;
}

/** Только тесты: сбросить билеты. */
export function resetTicketsForTests(): void {
  store.clear();
}

export function ticketCount(): number {
  return store.size;
}
