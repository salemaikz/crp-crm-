// Выход из приложения (D-063): перед выходом неотправленные итоги уходят на сервер, кэш оболочки очищается.
// Если что-то не ушло (нет сети), выход требует подтверждения: итоги останутся на телефоне до следующего входа.
import { createCallApi } from './api';
import { deviceHeaders, ensureDeviceId } from './device';
import { Outbox } from './outbox';
import { createDeviceStore } from './outboxStore';
import { clearShellCache } from './serviceWorker';

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
  const api = createCallApi(() => deviceHeaders(deviceId, holder.outbox?.pendingCount() ?? 0, holder.outbox?.lastFlushAt() ?? null));
  const outbox = new Outbox({ store, send: (req) => api.sendOutcome(req), userId });
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

/** Второй шаг: сессия закрывается на сервере, кэш оболочки очищается. Ошибка сети не мешает уйти на вход. */
export async function finishLogout(): Promise<void> {
  await clearShellCache().catch(() => undefined);
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.replace('/login');
  }
}
