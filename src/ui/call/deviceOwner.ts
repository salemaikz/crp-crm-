// Общий телефон, смена сотрудника без выхода (D-291, ARCHITECTURE §7): сессия A истекла, вошёл B. При загрузке
// под B всё, что на телефоне принадлежит другому сотруднику, удаляется или обезличивается:
// - черновик шторки и «намерение звонка» (название компании, закрытые номера) — удаляются;
// - счётчик за сутки — удаляется;
// - отказы сервера (в них названия компаний) — удаляются;
// - неотправленные итоги — остаются (терять итог нельзя), но без названия компании: только id и коды запроса.
//   Их outbox B не читает (хранилище отдаёт записи по userId), уходят они только под A и с заголовком автора A.
// Открытая вкладка A при этом не перезагружается сама: её сотрудника сверяет метка владельца телефона (D-292, ниже).
import type { OutboxStore } from './outboxStore';
import type { StorageLike } from './tally';

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

/** Убрать с телефона данные других сотрудников. Ошибки хранилища не бросает: это уборка, а не условие работы. */
export async function sanitizeForeign(userId: string, deps: { storage: ScanStorage | null; store: OutboxStore | null }): Promise<void> {
  if (deps.storage) {
    try {
      for (const k of foreignKeys(deps.storage, userId)) deps.storage.removeItem(k);
    } catch {
      // хранилище недоступно
    }
  }
  if (!deps.store) return;
  try {
    for (const e of await deps.store.allExcept(userId)) {
      if (e.title !== '') await deps.store.put({ ...e, title: '' });
    }
    await deps.store.clearRejectedExcept(userId);
  } catch {
    // IndexedDB недоступна
  }
}
