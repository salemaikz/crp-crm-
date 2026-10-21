// Хранилище outbox на устройстве: IndexedDB в браузере, память в тестах. Здесь лежат только итоги, которые
// ещё не дошли до сервера, и отказы сервера; очередь карточек и номера клиентов в IndexedDB не пишутся
// (ARCHITECTURE §7: ПДн на телефоне не копятся).
import type { OutboxEntry, RejectedEntry } from './types';

export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  remove(opId: string): Promise<void>;
  get(opId: string): Promise<OutboxEntry | null>;
  all(userId: string): Promise<OutboxEntry[]>;
  putRejected(entry: RejectedEntry): Promise<void>;
  rejected(userId: string): Promise<RejectedEntry[]>;
  removeRejected(opId: string): Promise<void>;
  /** Выход: отказы сервера этого сотрудника (в них названия компаний) удаляются совсем. */
  clearRejected(userId: string): Promise<void>;
  /** Итоги других сотрудников на этом телефоне (D-291: при входе нового они обезличиваются). */
  allExcept(userId: string): Promise<OutboxEntry[]>;
  /** Отказы сервера всех, кроме `userId`, удаляются (D-291). */
  clearRejectedExcept(userId: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /**
   * Чтение-изменение-запись одного ключа метаданных атомарно: в IndexedDB — одна readwrite-транзакция (вкладки и
   * параллельные вызовы одной вкладки встают в очередь), в памяти — без await между чтением и записью. `fn` —
   * синхронная; вернёт null — ключ не меняется. Результат — записанное значение (или прежнее).
   */
  updateMeta(key: string, fn: (current: string | null) => string | null): Promise<string | null>;
}

/** Хранилище в памяти: тесты и запасной вариант, когда IndexedDB недоступна (приватный режим). */
export function createMemoryStore(): OutboxStore {
  const outbox = new Map<string, OutboxEntry>();
  const rejected = new Map<string, RejectedEntry>();
  const meta = new Map<string, string>();
  return {
    put: async (e) => void outbox.set(e.opId, structuredClone(e)),
    remove: async (id) => void outbox.delete(id),
    get: async (id) => {
      const e = outbox.get(id);
      return e ? structuredClone(e) : null;
    },
    all: async (userId) => [...outbox.values()].filter((e) => e.userId === userId).map((e) => structuredClone(e)),
    putRejected: async (e) => void rejected.set(e.opId, structuredClone(e)),
    rejected: async (userId) => [...rejected.values()].filter((e) => e.userId === userId).map((e) => structuredClone(e)),
    removeRejected: async (id) => void rejected.delete(id),
    clearRejected: async (userId) => {
      for (const [id, e] of rejected) if (e.userId === userId) rejected.delete(id);
    },
    allExcept: async (userId) => [...outbox.values()].filter((e) => e.userId !== userId).map((e) => structuredClone(e)),
    clearRejectedExcept: async (userId) => {
      for (const [id, e] of rejected) if (e.userId !== userId) rejected.delete(id);
    },
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => void meta.set(k, v),
    updateMeta: async (k, fn) => {
      const cur = meta.get(k) ?? null;
      const next = fn(cur);
      if (next === null) return cur;
      meta.set(k, next);
      return next;
    },
  };
}

const DB_NAME = 'crm-call';
const DB_VERSION = 1;
const OUTBOX = 'outbox';
const REJECTED = 'rejected';
const META = 'meta';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'opId' });
      if (!db.objectStoreNames.contains(REJECTED)) db.createObjectStore(REJECTED, { keyPath: 'opId' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb'));
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb'));
  });
}

/** IndexedDB «crm-call»: outbox, отказы сервера и мелкие метаданные (id устройства, последняя отправка). */
export function createIndexedDbStore(): OutboxStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= open());
  const store = async (name: string, mode: IDBTransactionMode) => (await db()).transaction(name, mode).objectStore(name);
  const everything = async <T extends { userId: string }>(name: string): Promise<T[]> => (await wrap((await store(name, 'readonly')).getAll())) as T[];
  const allOf = async <T extends { userId: string }>(name: string, userId: string): Promise<T[]> => (await everything<T>(name)).filter((e) => e.userId === userId);
  return {
    put: async (e) => void (await wrap((await store(OUTBOX, 'readwrite')).put(e))),
    remove: async (id) => void (await wrap((await store(OUTBOX, 'readwrite')).delete(id))),
    get: async (id) => ((await wrap((await store(OUTBOX, 'readonly')).get(id))) as OutboxEntry | undefined) ?? null,
    all: (userId) => allOf<OutboxEntry>(OUTBOX, userId),
    putRejected: async (e) => void (await wrap((await store(REJECTED, 'readwrite')).put(e))),
    rejected: (userId) => allOf<RejectedEntry>(REJECTED, userId),
    removeRejected: async (id) => void (await wrap((await store(REJECTED, 'readwrite')).delete(id))),
    clearRejected: async (userId) => {
      for (const e of await allOf<RejectedEntry>(REJECTED, userId)) await wrap((await store(REJECTED, 'readwrite')).delete(e.opId));
    },
    allExcept: async (userId) => (await everything<OutboxEntry>(OUTBOX)).filter((e) => e.userId !== userId),
    clearRejectedExcept: async (userId) => {
      for (const e of (await everything<RejectedEntry>(REJECTED)).filter((x) => x.userId !== userId)) await wrap((await store(REJECTED, 'readwrite')).delete(e.opId));
    },
    getMeta: async (key) => {
      const row = (await wrap((await store(META, 'readonly')).get(key))) as { key: string; value: string } | undefined;
      return row?.value ?? null;
    },
    setMeta: async (key, value) => void (await wrap((await store(META, 'readwrite')).put({ key, value }))),
    updateMeta: async (key, fn) => {
      // Чтение и запись в одной транзакции: между ними нет await, иначе транзакция закрылась бы и чужая запись
      // (другая вкладка, параллельная уборка) вклинилась бы — потерянное обновление очереди
      const tx = (await db()).transaction(META, 'readwrite');
      const os = tx.objectStore(META);
      return new Promise<string | null>((resolve, reject) => {
        let result: string | null = null;
        const get = os.get(key);
        get.onsuccess = () => {
          const cur = (get.result as { key: string; value: string } | undefined)?.value ?? null;
          let next: string | null;
          try {
            next = fn(cur);
          } catch (e) {
            tx.abort();
            reject(e);
            return;
          }
          result = next ?? cur;
          if (next !== null) os.put({ key, value: next });
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error('indexeddb'));
        tx.onabort = () => reject(tx.error ?? new Error('indexeddb'));
      });
    },
  };
}

/** IndexedDB есть → она; иначе память (итоги тогда переживут только вкладку — оператору покажем предупреждение). */
export function createDeviceStore(): { store: OutboxStore; persistent: boolean } {
  if (typeof indexedDB === 'undefined') return { store: createMemoryStore(), persistent: false };
  return { store: createIndexedDbStore(), persistent: true };
}
