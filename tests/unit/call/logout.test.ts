// Выход: итоги уходят до выхода, остаток считается; сбой сети не бросает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../../src/ui/call/outboxStore';
import { purgeDevice, flushForLogout } from '../../../src/ui/call/logout';

const outbox = (pending: number, over: { flushFails?: boolean; sends?: number } = {}) => {
  const calls: string[] = [];
  let left = pending;
  return {
    calls,
    load: async () => void calls.push('load'),
    flush: async (opts: { force: true }) => {
      calls.push(`flush:${opts.force}`);
      if (over.flushFails) throw new Error('offline');
      left = Math.max(0, left - (over.sends ?? left));
    },
    pendingCount: () => left,
  };
};

test('всё ушло: 0 неотправленных, отправка без ожидания окна отмены', async () => {
  const o = outbox(3);
  assert.equal(await flushForLogout(o), 0);
  assert.deepEqual(o.calls, ['load', 'flush:true']);
});

test('часть не ушла: возвращается остаток для предупреждения', async () => {
  assert.equal(await flushForLogout(outbox(5, { sends: 2 })), 3);
});

test('нет сети: ошибка не бросается, остаток тот же', async () => {
  assert.equal(await flushForLogout(outbox(2, { flushFails: true })), 2);
});

test('нечего отправлять: 0', async () => {
  assert.equal(await flushForLogout(outbox(0)), 0);
});

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const entry = (opId: string, userId: string) => ({
  opId, userId, notBefore: 0, attempts: 0, retryAt: 0, createdAt: 1, title: 'ТОО Синтетик', kind: 'no_answer' as const,
  request: { opId } as never,
});

test('очистка устройства: черновик, счётчик и отказы пользователя удалены, чужие остались', async () => {
  const storage = mem();
  for (const u of ['u1', 'u2']) {
    storage.setItem(`crm.call.pending.${u}`, '{"call":{}}');
    storage.setItem(`crm.call.tally.${u}`, '{}');
  }
  const store = createMemoryStore();
  await store.putRejected({ opId: 'r1', userId: 'u1', title: 'ТОО Синтетик', code: 'x', at: 1 });
  await store.putRejected({ opId: 'r2', userId: 'u2', title: 'ТОО Другой', code: 'x', at: 1 });
  await purgeDevice('u1', { storage, store });
  assert.deepEqual([...storage.m.keys()].sort(), ['crm.call.pending.u2', 'crm.call.tally.u2']);
  assert.equal((await store.rejected('u1')).length, 0);
  assert.equal((await store.rejected('u2')).length, 1);
});

test('«Всё равно выйти»: неотправленные итоги остаются, но без названия компании', async () => {
  const store = createMemoryStore();
  await store.put(entry('o1', 'u1'));
  await purgeDevice('u1', { storage: mem(), store });
  const left = await store.all('u1');
  assert.equal(left.length, 1);
  assert.equal(left[0]!.title, '');
  assert.equal(left[0]!.opId, 'o1');
});
