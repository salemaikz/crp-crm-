// Выход из приложения (D-063): перед выходом неотправленные итоги уходят на сервер, потом телефон очищается:
// черновик шторки и счётчик за день (localStorage), отказы сервера (IndexedDB), кэш оболочки (Cache Storage).
// Если что-то не ушло (нет сети), выход требует подтверждения: на телефоне остаются только неотправленные итоги,
// без названий компаний (в них только то, что нужно для отправки), до следующего входа этого же сотрудника.
// Сессию закрывает только сервер: до запроса ставится флаг «выход не завершён» (logoutPending.ts), и пока сервер
// не ответил, любая страница показывает экран блокировки вместо данных и повторяет выход.
import { createCallApi } from './api';
import { deviceHeaders, ensureDeviceId } from './device';
import { Outbox } from './outbox';
import { createDeviceStore } from './outboxStore';
import { browserStorage, clearLogoutPending, isLogoutPending, LOGOUT_PENDING_ATTR, LOGOUT_PENDING_EVENT, markLogoutPending, postLogout } from './logoutPending';
import { blockShell, clearShellCache, isStaleShell, unblockShell } from './serviceWorker';
import { clearPending } from './pending';
import { clearTally, type StorageLike } from './tally';
import type { OutboxStore } from './outboxStore';

/** Что нужно от outbox при выходе (узкий срез для тестов). */
export interface FlushableOutbox {
  load(): Promise<void>;
  flush(opts: { force: true }): Promise<unknown>;
  pendingCount(): number;
}

/** Отправить всё сразу, не дожидаясь окна отмены (оператор уходит), и вернуть число оставшихся. Не бросает. */
export async function flushForLogout(outbox: FlushableOutbox): Promise<number> {
  try {
    await outbox.load();
    await outbox.flush({ force: true });
  } catch {
    // сеть или хранилище недоступны: считаем то, что осталось
  }
  return outbox.pendingCount();
}

/** Outbox этого устройства для сотрудника `userId`; отправка пойдёт под текущей сессией. */
export async function openDeviceOutbox(userId: string): Promise<Outbox> {
  const { store } = createDeviceStore();
  const deviceId = await ensureDeviceId(store);
  const holder: { outbox?: Outbox } = {};
  const api = createCallApi(() => deviceHeaders(deviceId, holder.outbox?.pendingCount() ?? 0, holder.outbox?.lastFlushAt() ?? null), userId);
  // Страница из кэша service worker (сессия могла смениться) или выход не завершён: ничего не отправляем
  const send = (req: Parameters<typeof api.sendOutcome>[0], author: string) =>
    isStaleShell() || isLogoutPending() ? Promise.reject(new Error('blocked')) : api.sendOutcome(req, author);
  const outbox = new Outbox({ store, send, userId });
  holder.outbox = outbox;
  return outbox;
}

/** Первый шаг выхода: отправить итоги. Число неотправленных; 0 — можно выходить. */
export async function flushDeviceOutbox(userId: string): Promise<number> {
  try {
    return await flushForLogout(await openDeviceOutbox(userId));
  } catch {
    return 0;
  }
}

/**
 * Очистка устройства для сотрудника: черновик, счётчик и отказы сервера удаляются всегда; в неотправленных итогах
 * (если «Всё равно выйти») стираются названия компаний, остаётся только содержимое запроса, нужное для отправки.
 */
export async function purgeDevice(userId: string, deps: { storage: StorageLike; store: OutboxStore }): Promise<void> {
  clearPending(deps.storage, userId);
  clearTally(deps.storage, userId);
  await deps.store.clearRejected(userId);
  for (const e of await deps.store.all(userId)) {
    if (e.title !== '') await deps.store.put({ ...e, title: '' });
  }
}

/**
 * Второй шаг. Сначала флаг «выход не завершён» и метка для service worker, потом очистка телефона и кэша оболочки,
 * потом запрос выхода. Сервер ответил — флаг снят, открывается вход. Нет сети — на вход не уходим (сессия жива,
 * следующий человек попал бы в неё): экран блокировки (LogoutGuard) прячет страницу и повторяет запрос.
 */
export async function finishLogout(userId: string): Promise<void> {
  const storage = browserStorage();
  // Флаг до всего остального: закроют вкладку посреди выхода — следующая загрузка любой страницы его доведёт.
  // Экран блокировки включается только если сервер не ответил: при сети выход занимает доли секунды
  markLogoutPending(storage);
  await blockShell().catch(() => undefined);
  try {
    await purgeDevice(userId, { storage: window.localStorage, store: createDeviceStore().store });
  } catch {
    // хранилище недоступно: чистить нечего
  }
  await clearShellCache().catch(() => undefined);
  if (await postLogout()) {
    await unblockShell().catch(() => undefined);
    clearLogoutPending(storage);
    window.location.replace('/login');
    return;
  }
  document.documentElement.setAttribute(LOGOUT_PENDING_ATTR, '');
  window.dispatchEvent(new Event(LOGOUT_PENDING_EVENT));
}
