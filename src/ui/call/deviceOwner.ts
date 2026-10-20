// Общий телефон, смена сотрудника без выхода (D-291, ARCHITECTURE §7): сессия A истекла, вошёл B. При загрузке
// под B всё, что на телефоне принадлежит другому сотруднику, удаляется или обезличивается:
// - черновик шторки и «намерение звонка» (название компании, закрытые номера) — удаляются;
// - счётчик за сутки — удаляется;
// - отказы сервера (в них названия компаний) — удаляются;
// - неотправленные итоги — остаются (терять итог нельзя), но без названия компании: только id и коды запроса.
//   Их outbox B не читает (хранилище отдаёт записи по userId), уходят они только под A и с заголовком автора A.
import type { OutboxStore } from './outboxStore';
import type { StorageLike } from './tally';

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
