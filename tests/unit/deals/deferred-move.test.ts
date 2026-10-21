// Отложенный перенос (D-266): отправка через 5 с, «Отменить» снимает таймер, уход со страницы отправляет сразу.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeferredMoves, UNDO_DELAY_MS, type MoveRequest, type Timers } from '../../../src/app/(mgr)/deals/deferredMove';

function clock() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      seq += 1;
      jobs.set(seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h) => void jobs.delete(h as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, j] of [...jobs]) if (j.at <= now) {
      jobs.delete(id);
      j.fn();
    }
  };
  return { timers, advance };
}

const mv = (opId: string, dealId = 'd1', stageKey = 'o'): MoveRequest => ({ opId, dealId, version: 3, stageKey, fromStageKey: 'n' });

function setup() {
  const c = clock();
  const sent: Array<[string, boolean]> = [];
  const q = new DeferredMoves({ delayMs: UNDO_DELAY_MS, timers: c.timers, send: (m, o) => sent.push([m.opId, o.keepalive]) });
  return { c, sent, q };
}

test('перенос уходит ровно через 5 секунд, один раз', () => {
  const { c, sent, q } = setup();
  q.schedule(mv('a'));
  c.advance(4999);
  assert.deepEqual(sent, []);
  c.advance(1);
  assert.deepEqual(sent, [['a', false]]);
  c.advance(60_000);
  assert.equal(sent.length, 1);
  assert.equal(q.size, 0);
});

test('«Отменить» в окне: на сервер ничего не уходит', () => {
  const { c, sent, q } = setup();
  q.schedule(mv('a'));
  c.advance(3000);
  assert.equal(q.cancel('a')?.opId, 'a');
  c.advance(10_000);
  assert.deepEqual(sent, []);
  assert.equal(q.cancel('a'), null, 'повторная отмена — уже нечего снимать');
});

test('отмена после отправки невозможна', () => {
  const { c, sent, q } = setup();
  q.schedule(mv('a'));
  c.advance(5000);
  assert.equal(q.cancel('a'), null);
  assert.equal(sent.length, 1);
});

test('новый перенос той же сделки заменяет прежний неотправленный; другая сделка независима', () => {
  const { c, sent, q } = setup();
  q.schedule(mv('a', 'd1', 'o'));
  q.schedule(mv('b', 'd2', 'o'));
  c.advance(2000);
  assert.equal(q.schedule(mv('c', 'd1', 'c'))?.opId, 'a');
  c.advance(3000);
  assert.deepEqual(sent, [['b', false]], 'первый таймер d1 снят, второй ещё идёт');
  c.advance(2000);
  assert.deepEqual(sent, [['b', false], ['c', false]]);
});

test('уход со страницы: всё неотправленное уходит сразу с keepalive, таймеры сняты', () => {
  const { c, sent, q } = setup();
  q.schedule(mv('a', 'd1'));
  q.schedule(mv('b', 'd2'));
  assert.equal(q.flushAll(), 2);
  assert.deepEqual(sent, [['a', true], ['b', true]]);
  c.advance(10_000);
  assert.equal(sent.length, 2, 'после flush таймеры не стреляют повторно');
  assert.equal(q.flushAll(), 0);
});
