// Выход: итоги уходят до выхода, остаток считается; сбой сети не бросает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flushForLogout } from '../../../src/ui/call/logout';

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
