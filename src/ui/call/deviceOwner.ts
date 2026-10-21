// Общий телефон, смена сотрудника без выхода (D-291, ARCHITECTURE §7): сессия A истекла, вошёл B. При загрузке
// под B всё, что на телефоне принадлежит другому сотруднику, удаляется или обезличивается:
// - черновик шторки и «намерение звонка» (название компании, закрытые номера) — удаляются;
// - счётчик за сутки — удаляется;
// - отказы сервера (в них названия компаний) — удаляются;
// - неотправленные итоги — остаются (терять итог нельзя), но без названия компании: только id и коды запроса.
//   Их outbox B не читает (хранилище отдаёт записи по userId), уходят они только под A и с заголовком автора A.
// Итоги другого сотрудника со свободным текстом (заметка, ЛПР) старше `calling.offlineWindowHours` удаляются: телефон
// сообщает серверу о потере (журнал) и только после ответа удаляет их (D-293 п. 2).
// Открытая вкладка A при этом не перезагружается сама: её сотрудника сверяет метка владельца телефона и сервер (D-292).
import { ensureDeviceId } from './device';
import { entryHasFreeText } from './freeText';
import type { OutboxStore } from './outboxStore';
import type { StorageLike } from './tally';
import type { OutboxEntry } from './types';

/**
 * Метка владельца телефона (D-292): id сотрудника, чья страница последней пришла с сервера. Внутренний id, не ПДн.
 * Каждая страница оболочки ставит её при загрузке; страница, чей сотрудник с меткой не совпал, устарела: на телефоне
 * уже работает другой. Такая вкладка прячет разметку и перезагружается, ничего не пишет на телефон и не шлёт.
 */
export const DEVICE_OWNER_KEY = 'crm.device.owner';
/** Атрибут <html>: CSS прячет страницу прежнего сотрудника до перезагрузки (globals.css). */
export const OWNER_CHANGED_ATTR = 'data-owner-changed';
/** Событие страницы: сотрудник сменился, экран «Звонить» убирает очередь из памяти и больше ничего не пишет. */
export const OWNER_CHANGED_EVENT = 'crm:owner-changed';

/** Поставить метку: страница сотрудника `userId` только что пришла с сервера. */
export function markDeviceOwner(storage: StorageLike | null, userId: string): void {
  try {
    if (storage && storage.getItem(DEVICE_OWNER_KEY) !== userId) storage.setItem(DEVICE_OWNER_KEY, userId);
  } catch {
    // хранилище недоступно: остаётся проверка на сервере (X-Call-Author, D-291)
  }
}

/**
 * На телефоне уже работает другой сотрудник: метка есть и не совпадает с `userId` страницы. Нет метки или хранилища —
 * false (сменившуюся сессию тогда ловит сервер: 409 `wrong_user` на запросах экрана «Звонить»).
 */
export function ownerChanged(storage: StorageLike | null, userId: string): boolean {
  try {
    const owner = storage?.getItem(DEVICE_OWNER_KEY) ?? null;
    return owner !== null && owner !== userId;
  } catch {
    return false;
  }
}

/**
 * Страница прежнего сотрудника: спрятать разметку сразу, сообщить экрану «Звонить» и перезагрузить — сервер отдаст
 * страницу текущей сессии или вход. Страницу из кэша service worker не перезагружаем (без сети это та же страница):
 * её перезагрузит экран «Звонить», когда появится сеть.
 */
export function leaveForeignPage(opts: { reload: boolean }): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(OWNER_CHANGED_ATTR, '');
  window.dispatchEvent(new Event(OWNER_CHANGED_EVENT));
  if (opts.reload) window.location.reload();
}

/**
 * Чья сессия у cookie, по ответу сервера (D-292): `same` — сотрудника страницы; `other` — вошёл другой (409
 * `wrong_user`); `gone` — сессии нет (истекла, «выйти везде», сотрудник отключён); `unknown` — нет сети или сбой.
 */
export type PageSession = 'same' | 'other' | 'gone' | 'unknown';

/** Сверка сессии вкладки: заголовок X-Call-Author с сотрудником страницы, как у запросов экрана «Звонить». */
export async function checkPageSession(userId: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<PageSession> {
  try {
    const res = await fetchImpl('/api/device/session', { cache: 'no-store', credentials: 'same-origin', headers: { 'X-Call-Author': userId } });
    if (res.ok) return 'same';
    if (res.status === 401) return 'gone';
    if (res.status === 409) return 'other';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Срок итогов другого сотрудника на телефоне (D-293 п. 2) и как сообщить серверу о потере. */
export interface ExpireForeign {
  now: number;
  /** `calling.offlineWindowHours` в мс. */
  ttlMs: number;
  /** Записать потерю на сервере до удаления. false — не удалять, попробовать при следующей загрузке. */
  report(authorId: string, opIds: string[]): Promise<boolean>;
}

/** Сколько opId в одном сообщении о потере (предел маршрута). */
const EXPIRE_CHUNK = 100;

/** Итоги других сотрудников со свободным текстом, пролежавшие на телефоне дольше срока: по авторам. */
export function expiredForeign(entries: readonly OutboxEntry[], userId: string, now: number, ttlMs: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    if (e.userId === userId || !entryHasFreeText(e) || now - e.createdAt < ttlMs) continue;
    out.set(e.userId, [...(out.get(e.userId) ?? []), e.opId]);
  }
  return out;
}

/** Сообщение о потере: POST /api/device/outbox-expired (запись журнала под сессией телефона). */
export function createExpiredReporter(store: OutboxStore, fetchImpl: typeof fetch = (...a) => fetch(...a)): ExpireForeign['report'] {
  return async (authorId, opIds) => {
    try {
      const deviceId = await ensureDeviceId(store);
      const res = await fetchImpl('/api/device/outbox-expired', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
        body: JSON.stringify({ authorId, opIds }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
}

/** localStorage с перебором ключей. */
export interface ScanStorage extends StorageLike {
  readonly length: number;
  key(index: number): string | null;
}

/** Ключи экрана «Звонить», привязанные к сотруднику: `<префикс><userId>` (pending.ts, tally.ts). */
const USER_KEY_PREFIXES = ['crm.call.pending.', 'crm.call.tally.'] as const;

/** Ключи localStorage других сотрудников. */
export function foreignKeys(storage: ScanStorage, userId: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k === null) continue;
    const prefix = USER_KEY_PREFIXES.find((p) => k.startsWith(p));
    if (prefix && k.slice(prefix.length) !== userId) out.push(k);
  }
  return out;
}

/**
 * Убрать с телефона данные других сотрудников. Ошибки хранилища не бросает: это уборка, а не условие работы.
 * `expire` — удалить их итоги со свободным текстом старше срока (D-293 п. 2); без него итоги только обезличиваются.
 */
export async function sanitizeForeign(userId: string, deps: { storage: ScanStorage | null; store: OutboxStore | null; expire?: ExpireForeign }): Promise<void> {
  if (deps.storage) {
    try {
      for (const k of foreignKeys(deps.storage, userId)) deps.storage.removeItem(k);
    } catch {
      // хранилище недоступно
    }
  }
  if (!deps.store) return;
  const store = deps.store;
  let foreign: OutboxEntry[] = [];
  try {
    foreign = await store.allExcept(userId);
    for (const e of foreign) {
      if (e.title === '') continue;
      // Запись перечитывается: другая уборка (вторая вкладка) могла её уже удалить — не воскрешаем
      const cur = await store.get(e.opId);
      if (cur && cur.title !== '') await store.put({ ...cur, title: '' });
    }
    await store.clearRejectedExcept(userId);
  } catch {
    // IndexedDB недоступна
    return;
  }
  if (!deps.expire) return;
  const { now, ttlMs, report } = deps.expire;
  for (const [author, opIds] of expiredForeign(foreign, userId, now, ttlMs)) {
    for (let i = 0; i < opIds.length; i += EXPIRE_CHUNK) {
      const chunk = opIds.slice(i, i + EXPIRE_CHUNK);
      // Сначала журнал на сервере, потом удаление: без ответа сервера итог остаётся до следующей загрузки
      if (!(await report(author, chunk).catch(() => false))) return;
      try {
        for (const id of chunk) await store.remove(id);
      } catch {
        return;
      }
    }
  }
}
