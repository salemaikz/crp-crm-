// Выход из приложения (D-063): перед выходом неотправленные итоги уходят на сервер, потом телефон очищается:
// черновик шторки и счётчик за день (localStorage), отказы сервера (IndexedDB), кэш оболочки (Cache Storage).
// Если что-то не ушло (нет сети), выход требует подтверждения: на телефоне остаются только неотправленные итоги,
// без названий компаний (в них только то, что нужно для отправки), до следующего входа этого же сотрудника.
// Итог со свободным текстом оператора (заметка, данные ЛПР — D-293) на телефоне не остаётся: «Всё равно выйти» для него
// нет, оператор либо остаётся до сети, либо явно удаляет такие итоги (они теряются).
// Сессию закрывает только сервер: до запроса ставится флаг «выход не завершён» (logoutPending.ts), и пока сервер
// не ответил, любая страница показывает экран блокировки вместо данных и повторяет выход.
import { createCallApi } from './api';
import { deviceHeaders, ensureDeviceId } from './device';
import { queueExpiredReport } from './expiredReports';
import { entryHasFreeText } from './freeText';
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

/** Что не ушло при выходе: всего и сколько из них со свободным текстом оператора (D-293). */
export interface Unsent {
  count: number;
  freeText: number;
}

/** Неотправленные итоги со свободным текстом. Хранилище недоступно — 0 (на телефоне и лежать нечему). */
export async function countFreeText(store: OutboxStore, userId: string): Promise<number> {
  try {
    return (await store.all(userId)).filter(entryHasFreeText).length;
  } catch {
    return 0;
  }
}

/** Первый шаг выхода: отправить итоги. Сколько не ушло; `count: 0` — можно выходить. */
export async function flushDeviceOutbox(userId: string): Promise<Unsent> {
  try {
    const count = await flushForLogout(await openDeviceOutbox(userId));
    return { count, freeText: count > 0 ? await countFreeText(createDeviceStore().store, userId) : 0 };
  } catch {
    return { count: 0, freeText: 0 };
  }
}

/**
 * Очистка устройства для сотрудника: черновик, счётчик и отказы сервера удаляются всегда; в неотправленных итогах
 * (если «Всё равно выйти») стираются названия компаний, остаётся только содержимое запроса, нужное для отправки.
 * `discardFreeText` — оператор подтвердил удаление итогов со свободным текстом: они удаляются целиком (D-293), а их
 * opId встают в очередь сообщений о потере с причиной `discarded` (D-311).
 */
export async function purgeDevice(userId: string, deps: { storage: StorageLike; store: OutboxStore; discardFreeText?: boolean }): Promise<void> {
  clearPending(deps.storage, userId);
  clearTally(deps.storage, userId);
  await deps.store.clearRejected(userId);
  const entries = await deps.store.all(userId);
  const discarded = deps.discardFreeText ? entries.filter(entryHasFreeText).map((e) => e.opId) : [];
  // Явная потеря тоже не молчаливая (D-293, D-311): сначала след на телефоне (только id), потом удаление. Сообщение
  // уходит при следующей загрузке с сессией — под автором или под тем, кто войдёт следующим (D-309)
  if (discarded.length > 0) await queueExpiredReport(deps.store, userId, discarded, 'discarded');
  const gone = new Set(discarded);
  for (const e of entries) {
    if (gone.has(e.opId)) await deps.store.remove(e.opId);
    else if (e.title !== '') await deps.store.put({ ...e, title: '' });
  }
}

/** Итог второго шага: выход начат (`done`) или нужен явный ответ про итоги со свободным текстом (`confirm`). */
export type FinishResult = { kind: 'done' } | { kind: 'confirm'; freeText: number };

/**
 * Второй шаг. Сначала проверка: на телефоне есть итоги со свободным текстом, а удаление не подтверждено — выхода нет,
 * `confirm` (D-293). Потом флаг «выход не завершён» и метка для service worker, очистка телефона и кэша оболочки,
 * запрос выхода. Сервер ответил — флаг снят, открывается вход. Нет сети — на вход не уходим (сессия жива,
 * следующий человек попал бы в неё): экран блокировки (LogoutGuard) прячет страницу и повторяет запрос.
 */
export async function finishLogout(userId: string, opts: { discardFreeText?: boolean } = {}): Promise<FinishResult> {
  const { store } = createDeviceStore();
  if (!opts.discardFreeText) {
    const freeText = await countFreeText(store, userId);
    if (freeText > 0) return { kind: 'confirm', freeText };
  }
  const storage = browserStorage();
  // Флаг до всего остального: закроют вкладку посреди выхода — следующая загрузка любой страницы его доведёт.
  // Экран блокировки включается только если сервер не ответил: при сети выход занимает доли секунды
  markLogoutPending(storage);
  await blockShell().catch(() => undefined);
  try {
    await purgeDevice(userId, { storage: window.localStorage, store, discardFreeText: opts.discardFreeText === true });
  } catch {
    // хранилище недоступно: чистить нечего
  }
  await clearShellCache().catch(() => undefined);
  if (await postLogout()) {
    await unblockShell().catch(() => undefined);
    clearLogoutPending(storage);
    window.location.replace('/login');
    return { kind: 'done' };
  }
  document.documentElement.setAttribute(LOGOUT_PENDING_ATTR, '');
  window.dispatchEvent(new Event(LOGOUT_PENDING_EVENT));
  return { kind: 'done' };
}
