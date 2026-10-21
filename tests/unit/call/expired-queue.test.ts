// Очередь сообщений о потере (D-308, D-309, D-311): изменение очереди атомарно — уборка при загрузке, отправка по
// событию online и вторая вкладка не теряют записи; в IndexedDB чтение и запись — одна readwrite-транзакция. Явное
// удаление своих итогов при выходе тоже оставляет сообщение о потере (причина discarded).
// fake-indexeddb в зависимостях нет, поэтому ниже — минимальная подмена IndexedDB с очередью транзакций по хранилищу
// (как в браузере: readwrite-транзакции одного хранилища идут по одной, транзакция закрывается, когда в ней не
// осталось запросов).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedDbStore, createMemoryStore, type OutboxStore } from '../../../src/ui/call/outboxStore';
import { createExpiredReporter, flushExpiredReports, pendingExpiredReports, queueExpiredReport } from '../../../src/ui/call/expiredReports';
import { purgeDevice } from '../../../src/ui/call/logout';

const tick = () => new Promise((r) => setTimeout(r, 1));

/** Хранилище, у которого getMeta и setMeta — отдельные медленные шаги (как две транзакции IndexedDB). */
function slowMetaStore(): OutboxStore {
  const base = createMemoryStore();
  return {
    ...base,
    getMeta: async (k) => {
      const v = await base.getMeta(k);
      await tick();
      return v;
    },
    setMeta: async (k, v) => {
      await tick();
      await base.setMeta(k, v);
    },
  };
}

test('очередь: отправка старого сообщения и постановка нового одновременно — ни одно не теряется и не воскресает', async () => {
  const store = slowMetaStore();
  await queueExpiredReport(store, 'uC', ['c1']);
  // Отправка очереди (событие online) и уборка при загрузке (новый итог A) идут вперемешку
  const flushing = flushExpiredReports(store, async () => {
    await tick();
    return 'sent';
  });
  await tick();
  const queuing = queueExpiredReport(store, 'uA', ['a1']);
  await Promise.all([flushing, queuing]);
  assert.deepEqual(await pendingExpiredReports(store), [{ authorId: 'uA', opIds: ['a1'] }]);
});

test('очередь: десять параллельных постановок разных авторов — все в очереди', async () => {
  const store = slowMetaStore();
  await Promise.all(Array.from({ length: 10 }, (_, i) => queueExpiredReport(store, `u${i}`, [`op-${i}`])));
  const q = await pendingExpiredReports(store);
  assert.deepEqual(q.map((r) => r.authorId).sort(), Array.from({ length: 10 }, (_, i) => `u${i}`).sort());
});

// --- подмена IndexedDB ---------------------------------------------------------------------------------------------

type Req = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void };

function fakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>();
  const stats = { transactions: 0, readwrite: 0 };
  let chain: Promise<void> = Promise.resolve();

  function transaction(name: string, mode: string) {
    stats.transactions++;
    if (mode === 'readwrite') stats.readwrite++;
    let pending = 0;
    let finished = false;
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    const tx: Record<string, unknown> & { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error: unknown } = {
      error: null,
      abort: () => {
        finished = true;
        release();
        tx.onabort?.();
      },
      objectStore: () => os,
    };
    const started = chain.then(() => undefined);
    // Транзакции одного хранилища — по одной: следующая начнётся, когда эта закончится
    chain = chain.then(() => done);
    const finish = () => {
      if (pending > 0 || finished) return;
      finished = true;
      release();
      tx.oncomplete?.();
    };
    const request = (fn: () => unknown): Req => {
      if (finished) throw new Error('TransactionInactiveError');
      pending++;
      const req: Req = {};
      void started.then(() =>
        setTimeout(() => {
          req.result = fn();
          req.onsuccess?.();
          pending--;
          // Без новых запросов в обработчике транзакция закрывается (как в браузере)
          setTimeout(finish, 0);
        }, 0),
      );
      return req;
    };
    const data = () => stores.get(name)!;
    const os = {
      get: (k: string) => request(() => data().get(k)),
      put: (v: { key?: string; opId?: string }) => request(() => void data().set((v.key ?? v.opId)!, structuredClone(v))),
      delete: (k: string) => request(() => void data().delete(k)),
      getAll: () => request(() => [...data().values()]),
    };
    // Транзакция без запросов тоже закрывается
    void started.then(() => setTimeout(finish, 0));
    return tx;
  }

  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => void stores.set(n, new Map()),
    transaction,
  };
  return {
    stats,
    indexedDB: {
      open: () => {
        const req: Req = {};
        setTimeout(() => {
          req.result = db;
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      },
    },
  };
}

const g = globalThis as { indexedDB?: unknown };
afterEach(() => {
  delete g.indexedDB;
});

test('IndexedDB: updateMeta — одна readwrite-транзакция на изменение; параллельные изменения не теряются', async () => {
  const fake = fakeIndexedDb();
  g.indexedDB = fake.indexedDB;
  const store = createIndexedDbStore();
  await store.setMeta('n', '0');
  const before = fake.stats.transactions;
  await Promise.all(Array.from({ length: 20 }, () => store.updateMeta('n', (cur) => String(Number(cur) + 1))));
  assert.equal(await store.getMeta('n'), '20');
  assert.equal(fake.stats.transactions - before, 21, 'по одной транзакции на изменение и одна на чтение');
  // null из fn — ключ не меняется, ответ — прежнее значение
  assert.equal(await store.updateMeta('n', () => null), '20');
});

test('IndexedDB: очередь сообщений о потере при одновременных отправке и постановке ничего не теряет', async () => {
  const fake = fakeIndexedDb();
  g.indexedDB = fake.indexedDB;
  const store = createIndexedDbStore();
  await queueExpiredReport(store, 'uC', ['c1']);
  await Promise.all([
    flushExpiredReports(store, async () => 'sent'),
    queueExpiredReport(store, 'uA', ['a1']),
    queueExpiredReport(store, 'uB', ['b1']),
  ]);
  const q = await pendingExpiredReports(store);
  assert.deepEqual(q.map((r) => r.authorId).sort(), ['uA', 'uB']);
});

// --- явное удаление своих итогов при выходе ------------------------------------------------------------------------

const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const outcome = (opId: string, userId: string, note: string) => ({
  opId, userId, notBefore: 0, attempts: 0, retryAt: 0, createdAt: 1, title: 'ТОО Синтетика', kind: 'no_answer' as const,
  ...(note ? { freeText: true } : { freeText: false }),
  request: { opId, cardId: `cd-${opId}`, outcomeKey: 'no_answer', note, lprInfo: null, fields: {}, agreement: null } as never,
});

test('«Удалить их и выйти» (D-311): удалённые итоги со свободным текстом встают в очередь сообщений о потере с причиной discarded', async () => {
  const store = createMemoryStore();
  await store.put(outcome('t1', 'u1', 'Заметка Синтетик'));
  await store.put(outcome('t2', 'u1', 'Берик Синтетик-ЛПР'));
  await store.put(outcome('b1', 'u1', ''));
  await store.put(outcome('x1', 'u2', 'Чужая заметка'));
  await purgeDevice('u1', { storage: storage(), store, discardFreeText: true });
  assert.deepEqual(await pendingExpiredReports(store), [{ authorId: 'u1', opIds: ['t1', 't2'], reason: 'discarded' }]);
  assert.doesNotMatch(JSON.stringify(await pendingExpiredReports(store)), /Синтетик/);
  assert.deepEqual((await store.all('u1')).map((e) => e.opId), ['b1']);
  // Без подтверждения удаления очередь не растёт
  const other = createMemoryStore();
  await other.put(outcome('t3', 'u1', 'Заметка'));
  await purgeDevice('u1', { storage: storage(), store: other });
  assert.deepEqual(await pendingExpiredReports(other), []);

  // Сообщение уходит с причиной; автору тост «удалены по сроку» не показывается — удаление он подтвердил сам
  const sent: unknown[] = [];
  const own: number[] = [];
  const report = createExpiredReporter(store, (async (_url: string, init: RequestInit) => (sent.push(JSON.parse(String(init.body))), new Response('{}', { status: 200 }))) as never);
  assert.equal(await flushExpiredReports(store, report, { userId: 'u1', onOwnLost: (n) => own.push(n) }), true);
  assert.deepEqual(sent, [{ authorId: 'u1', opIds: ['t1', 't2'], reason: 'discarded' }]);
  assert.deepEqual(own, []);
});
