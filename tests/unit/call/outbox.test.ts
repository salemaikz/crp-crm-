// Outbox итогов на устройстве: окно отмены, отправка с повтором, классификация ответов, один проход за раз.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outbox, backoffMs, classify, type SendResult } from '../../../src/ui/call/outbox';
import { createMemoryStore } from '../../../src/ui/call/outboxStore';
import type { OutcomeRequest } from '../../../src/ui/call/types';

const req = (n: number): OutcomeRequest => ({
  opId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  cardId: `cd-${n}`,
  outcomeKey: 'no_answer',
  via: 'ui',
  occurredAt: 1_793_000_000_000 + n,
  tappedAt: null,
  phoneId: null,
  reasonCode: '',
  note: '',
  lpr: '',
  lprInfo: null,
  callbackAt: null,
  markTarget: false,
  alsoDncPhoneIds: [],
  fields: {},
  durationSec: null,
  agreement: null,
});

function setup(send: (r: OutcomeRequest) => Promise<SendResult>) {
  const clock = { now: 1_793_000_000_000 };
  const sent: OutcomeRequest[] = [];
  const store = createMemoryStore();
  let changes = 0;
  const outbox = new Outbox({
    store,
    userId: 'u1',
    now: () => clock.now,
    onChange: () => void changes++,
    send: async (r) => {
      sent.push(r);
      return send(r);
    },
  });
  return { clock, sent, store, outbox, changes: () => changes };
}
const item = (n: number, undoMs = 5000) => ({ request: req(n), title: `ТОО Синтетика ${n}`, kind: 'no_answer' as const, undoMs });

test('classify: 2xx — готово; 400/403/404 — отказ навсегда; сеть, 401, 423 и 5xx — повторять', () => {
  assert.equal(classify(200), 'sent');
  assert.equal(classify(201), 'sent');
  for (const s of [400, 403, 404, 409]) assert.equal(classify(s), 'rejected', String(s));
  for (const s of [401, 408, 423, 429, 500, 502, 503]) assert.equal(classify(s), 'retry', String(s));
});

test('пауза между повторами растёт и ограничена минутой', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backoffMs), [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
});

test('итог ждёт окно отмены и уходит после него; сервер до этого его не видит', async () => {
  const t = setup(async () => ({ status: 200 }));
  await t.outbox.enqueue(item(1));
  assert.equal(t.outbox.pendingCount(), 1);
  assert.deepEqual((await t.outbox.flush()).sent, [], 'окно не прошло');
  assert.equal(t.sent.length, 0);
  t.clock.now += 4_999;
  assert.equal((await t.outbox.flush()).sent.length, 0);
  t.clock.now += 1;
  const rep = await t.outbox.flush();
  assert.deepEqual(rep.sent, [req(1).opId]);
  assert.equal(t.sent.length, 1);
  assert.equal(t.outbox.pendingCount(), 0);
  assert.equal(t.outbox.lastFlushAt(), t.clock.now);
});

test('«Отменить» в окне убирает итог: на сервер он не попадает ни при каком проходе', async () => {
  const t = setup(async () => ({ status: 200 }));
  await t.outbox.enqueue(item(1));
  assert.equal(await t.outbox.cancel(req(1).opId), true);
  assert.equal(t.outbox.pendingCount(), 0);
  assert.equal(await t.store.get(req(1).opId), null, 'и из хранилища');
  t.clock.now += 60_000;
  await t.outbox.flush({ force: true });
  assert.equal(t.sent.length, 0);
  assert.equal(await t.outbox.cancel(req(1).opId), false, 'второй раз отменять нечего');
});

test('после отправки отменить нельзя', async () => {
  const t = setup(async () => ({ status: 200 }));
  await t.outbox.enqueue(item(1, 0));
  await t.outbox.flush();
  assert.equal(await t.outbox.cancel(req(1).opId), false);
});

test('сети нет: запись остаётся, проход останавливается, повтор по паузе; сеть вернулась — уходит всё без дублей', async () => {
  let online = false;
  const t = setup(async () => {
    if (!online) throw new Error('offline');
    return { status: 200 };
  });
  for (let n = 1; n <= 5; n++) await t.outbox.enqueue(item(n, 0));
  const first = await t.outbox.flush();
  assert.equal(first.offline, true);
  assert.equal(t.sent.length, 1, 'после первой неудачи остальные не пробуем');
  assert.equal(t.outbox.pendingCount(), 5);

  // Пауза у первой записи не прошла: обычный проход пробует только следующую и снова останавливается
  await t.outbox.flush();
  assert.deepEqual(t.sent.map((r) => r.cardId), ['cd-1', 'cd-2']);

  online = true;
  const attempts = t.sent.length;
  const rep = await t.outbox.flush({ ignoreBackoff: true });
  assert.equal(rep.sent.length, 5);
  assert.equal(t.outbox.pendingCount(), 0);
  const after = t.sent.slice(attempts).map((r) => r.opId);
  assert.equal(new Set(after).size, 5, 'каждый opId ушёл ровно один раз после возврата сети');
});

test('ответ потерян, а сервер итог принял: повтор с тем же opId безопасен, запись уходит один раз', async () => {
  let calls = 0;
  const t = setup(async () => {
    calls++;
    if (calls === 1) throw new Error('обрыв после приёма');
    return { status: 200 };
  });
  await t.outbox.enqueue(item(1, 0));
  await t.outbox.flush();
  assert.equal(t.outbox.pendingCount(), 1);
  await t.outbox.flush({ ignoreBackoff: true });
  assert.equal(t.outbox.pendingCount(), 0);
  assert.equal(t.sent[0]?.opId, t.sent[1]?.opId, 'повтор несёт прежний opId');
});

test('отказ сервера убирает итог и запоминает его для оператора; 5xx и 423 оставляют', async () => {
  const codes = new Map<string, SendResult>([
    [req(1).opId, { status: 404 }],
    [req(2).opId, { status: 400, code: 'lpr_required' }],
    [req(3).opId, { status: 503 }],
    [req(4).opId, { status: 423 }],
  ]);
  const t = setup(async (r) => codes.get(r.opId) ?? { status: 200 });
  for (let n = 1; n <= 4; n++) await t.outbox.enqueue(item(n, 0));
  const rep = await t.outbox.flush();
  assert.deepEqual(rep.rejected, [
    { opId: req(1).opId, code: 'not_found' },
    { opId: req(2).opId, code: 'lpr_required' },
  ]);
  assert.equal(t.outbox.pendingCount(), 2, 'сбой сервера и лицензия «только чтение» не теряют итог');
  const shown = await t.outbox.rejectedList();
  assert.deepEqual(shown.map((x) => x.code).sort(), ['lpr_required', 'not_found']);
  await t.outbox.dismissRejected(req(1).opId);
  assert.equal((await t.outbox.rejectedList()).length, 1);
});

test('перезапуск приложения: итоги читаются из хранилища и уходят', async () => {
  const t = setup(async () => ({ status: 200 }));
  await t.outbox.enqueue(item(1));
  await t.outbox.enqueue(item(2));
  const again = new Outbox({ store: t.store, userId: 'u1', now: () => t.clock.now + 10_000, send: async () => ({ status: 200 }) });
  await again.load();
  assert.equal(again.pendingCount(), 2);
  assert.deepEqual(again.cardIds().sort(), ['cd-1', 'cd-2']);
  const other = new Outbox({ store: t.store, userId: 'u2', send: async () => ({ status: 200 }) });
  await other.load();
  assert.equal(other.pendingCount(), 0, 'итоги другого сотрудника на этом устройстве не трогаются');
  assert.equal((await again.flush()).sent.length, 2);
});

test('параллельные проходы не шлют один итог дважды', async () => {
  let inFlight = 0;
  let max = 0;
  const t = setup(async () => {
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { status: 200 };
  });
  for (let n = 1; n <= 3; n++) await t.outbox.enqueue(item(n, 0));
  await Promise.all([t.outbox.flush(), t.outbox.flush(), t.outbox.flush()]);
  assert.equal(t.sent.length, 3);
  assert.equal(max, 1);
});

test('«Следующая»: force отправляет сразу, не дожидаясь окна', async () => {
  const t = setup(async () => ({ status: 200 }));
  await t.outbox.enqueue(item(1, 5000));
  assert.equal((await t.outbox.flush({ force: true })).sent.length, 1);
});

test('nextDueAt: ближайший срок отправки или паузы', async () => {
  const t = setup(async () => ({ status: 500 }));
  assert.equal(t.outbox.nextDueAt(), null);
  await t.outbox.enqueue(item(1, 5000));
  assert.equal(t.outbox.nextDueAt(), t.clock.now + 5000);
  t.clock.now += 5000;
  await t.outbox.flush();
  assert.equal(t.outbox.nextDueAt(), t.clock.now + 3000, 'после ошибки — пауза 3 с');
});

// ---- D-291: автор итога и общий телефон -----------------------------------------------------------------

test('classify: 409 wrong_user — держать до входа автора; прочие 409 — отказ', () => {
  assert.equal(classify(409, 'wrong_user'), 'hold');
  assert.equal(classify(409, 'skip_limit'), 'rejected');
  assert.equal(classify(400, 'wrong_user'), 'rejected');
});

test('отправка несёт автора записи: транспорт получает userId outbox', async () => {
  const authors: string[] = [];
  const store = createMemoryStore();
  const outbox = new Outbox({ store, userId: 'u1', send: async (_r, author) => (authors.push(author), { status: 200 }) });
  await outbox.enqueue(item(1, 0));
  await outbox.flush();
  assert.deepEqual(authors, ['u1']);
});

test('409 wrong_user: итог не теряется и не показывается отказом — остаётся в хранилище без названия, вкладка его больше не шлёт', async () => {
  const t = setup(async () => ({ status: 409, code: 'wrong_user' }));
  await t.outbox.enqueue(item(1, 0));
  await t.outbox.enqueue(item(2, 0));
  const rep = await t.outbox.flush();
  assert.deepEqual(rep.held, [req(1).opId], 'проход остановлен на первом: остальные под той же чужой сессией');
  assert.equal(t.outbox.has(req(1).opId), false);
  assert.equal((await t.outbox.rejectedList()).length, 0);
  const kept = await t.store.get(req(1).opId);
  assert.equal(kept?.title, '');
  assert.equal(kept?.userId, 'u1');
  assert.deepEqual(kept?.request, req(1), 'запрос (id и коды) цел — уйдёт при входе автора');
  // Автор вошёл снова: новая страница читает итог из хранилища и отправляет его
  const again = new Outbox({ store: t.store, userId: 'u1', send: async () => ({ status: 200 }) });
  await again.load();
  assert.equal((await again.flush({ force: true })).sent.length, 2);
});

test('вкладка не возвращает название в хранилище после очистки при выходе (later)', async () => {
  const t = setup(async () => {
    throw new Error('нет сети');
  });
  await t.outbox.enqueue(item(1, 0));
  // Выход в другой вкладке: purgeDevice стёр название в хранилище, память этой вкладки — прежняя
  const stored = (await t.store.get(req(1).opId))!;
  await t.store.put({ ...stored, title: '' });
  await t.outbox.flush();
  assert.equal((await t.store.get(req(1).opId))?.title, '');
  assert.equal((await t.store.get(req(1).opId))?.attempts, 1);
  assert.equal(t.outbox.list()[0]?.title, '', 'и в памяти вкладки тоже');
});

test('запись уже отправила или отменила другая вкладка: повтор её не воскрешает', async () => {
  const t = setup(async () => {
    throw new Error('нет сети');
  });
  await t.outbox.enqueue(item(1, 0));
  await t.store.remove(req(1).opId);
  await t.outbox.flush();
  assert.equal(await t.store.get(req(1).opId), null);
  assert.equal(t.outbox.pendingCount(), 0);
});

test('отказ сервера после очистки: подпись берётся из хранилища (пустая), а не из памяти вкладки', async () => {
  const t = setup(async () => ({ status: 404 }));
  await t.outbox.enqueue(item(1, 0));
  const stored = (await t.store.get(req(1).opId))!;
  await t.store.put({ ...stored, title: '' });
  await t.outbox.flush();
  assert.equal((await t.outbox.rejectedList())[0]?.title, '');
});
