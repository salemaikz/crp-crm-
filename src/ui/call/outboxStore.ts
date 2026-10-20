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
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
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
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => void meta.set(k, v),
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
  const allOf = async <T extends { userId: string }>(name: string, userId: string): Promise<T[]> =>
    ((await wrap((await store(name, 'readonly')).getAll())) as T[]).filter((e) => e.userId === userId);
  return {
    put: async (e) => void (await wrap((await store(OUTBOX, 'readwrite')).put(e))),
    remove: async (id) => void (await wrap((await store(OUTBOX, 'readwrite')).delete(id))),
    get: async (id) => ((await wrap((await store(OUTBOX, 'readonly')).get(id))) as OutboxEntry | undefined) ?? null,
    all: (userId) => allOf<OutboxEntry>(OUTBOX, userId),
    putRejected: async (e) => void (await wrap((await store(REJECTED, 'readwrite')).put(e))),
    rejected: (userId) => allOf<RejectedEntry>(REJECTED, userId),
    removeRejected: async (id) => void (await wrap((await store(REJECTED, 'readwrite')).delete(id))),
    getMeta: async (key) => {
      const row = (await wrap((await store(META, 'readonly')).get(key))) as { key: string; value: string } | undefined;
      return row?.value ?? null;
    },
    setMeta: async (key, value) => void (await wrap((await store(META, 'readwrite')).put({ key, value }))),
  };
}

/** IndexedDB есть → она; иначе память (итоги тогда переживут только вкладку — оператору покажем предупреждение). */
export function createDeviceStore(): { store: OutboxStore; persistent: boolean } {
  if (typeof indexedDB === 'undefined') return { store: createMemoryStore(), persistent: false };
  return { store: createIndexedDbStore(), persistent: true };
}
