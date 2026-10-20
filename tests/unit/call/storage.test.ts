// Сводка «Сегодня», намерение звонка и заголовки устройства.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceHeaders, ensureDeviceId, newDeviceId } from '../../../src/ui/call/device';
import { createMemoryStore } from '../../../src/ui/call/outboxStore';
import { clearPending, readPending, writePending } from '../../../src/ui/call/pending';
import { callsInLastHour, forgetOutcome, markBooked, readTally, recordOutcome, viewOf, type StorageLike } from '../../../src/ui/call/tally';
import { EMPTY_DRAFT } from '../../../src/ui/call/types';
import { parseDeviceHeaders } from '../../../src/server/domain/calls/device';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

test('сводка: итоги, дозвоны и записи; отмена итога убирает его; новые сутки начинаются с нуля', () => {
  const s = memory();
  recordOutcome(s, 'u1', '2026-10-28', { opId: 'a', kind: 'no_answer', at: 1000, booked: false });
  recordOutcome(s, 'u1', '2026-10-28', { opId: 'b', kind: 'callback', at: 2000, booked: false });
  recordOutcome(s, 'u1', '2026-10-28', { opId: 'b', kind: 'callback', at: 2000, booked: false });
  recordOutcome(s, 'u1', '2026-10-28', { opId: 'c', kind: 'agreed', at: 3000, booked: false });
  markBooked(s, 'u1', '2026-10-28', 'c', 3500);
  assert.deepEqual(viewOf(readTally(s, 'u1', '2026-10-28')), { outcomes: 3, connected: 2, booked: 1 });
  forgetOutcome(s, 'u1', '2026-10-28', 'b');
  assert.deepEqual(viewOf(readTally(s, 'u1', '2026-10-28')), { outcomes: 2, connected: 1, booked: 1 });
  assert.deepEqual(viewOf(readTally(s, 'u1', '2026-10-29')), { outcomes: 0, connected: 0, booked: 0 });
  assert.deepEqual(viewOf(readTally(s, 'u2', '2026-10-28')), { outcomes: 0, connected: 0, booked: 0 }, 'другой сотрудник на устройстве');
});

test('запись через мастер без итога на устройстве тоже считается', () => {
  const s = memory();
  const t = markBooked(s, 'u1', '2026-10-28', 'x', 5);
  assert.deepEqual(viewOf(t), { outcomes: 1, connected: 1, booked: 1 });
});

test('темп: звонки за последний час по моменту нажатия «Позвонить»', () => {
  const s = memory();
  const now = 10 * 3_600_000;
  recordOutcome(s, 'u1', 'd', { opId: '1', kind: 'no_answer', at: now - 30 * 60_000, booked: false });
  recordOutcome(s, 'u1', 'd', { opId: '2', kind: 'no_answer', at: now - 61 * 60_000, booked: false });
  recordOutcome(s, 'u1', 'd', { opId: '3', kind: 'no_answer', at: now - 1, booked: false });
  assert.equal(callsInLastHour(readTally(s, 'u1', 'd'), now), 2);
});

test('повреждённая запись сводки не ломает экран', () => {
  const s = memory();
  s.setItem('crm.call.tally.u1', '{не json');
  assert.deepEqual(readTally(s, 'u1', 'd'), { day: 'd', items: [] });
});

test('намерение звонка: пишется, читается с черновиком по умолчанию, чистится; цифр номера в записи нет', () => {
  const s = memory();
  assert.equal(readPending(s, 'u1'), null);
  const call = { opId: 'o1', cardId: 'cd-1', clientId: 'cl-1', tappedAt: 5, title: 'ТОО Синтетика', phoneId: 'ph-1', phoneMasked: '+7 709 ••• •• 01', phones: [{ id: 'ph-1', masked: '+7 709 ••• •• 01' }] };
  writePending(s, 'u1', { call, draft: { ...EMPTY_DRAFT, lpr: 'yes', open: true } });
  const back = readPending(s, 'u1');
  assert.equal(back?.call.opId, 'o1');
  assert.equal(back?.draft.lpr, 'yes');
  assert.equal(readPending(s, 'u2'), null);
  assert.ok(![...s.data.values()].some((v) => /7709\d{7}/.test(v)), 'полного номера на устройстве нет');
  clearPending(s, 'u1');
  assert.equal(readPending(s, 'u1'), null);
  s.setItem('crm.call.pending.u1', '[1,2]');
  assert.equal(readPending(s, 'u1'), null, 'мусор не открывает шторку');
});

test('устройство: id создаётся один раз и подходит серверу; заголовки разбирает parseDeviceHeaders', async () => {
  const store = createMemoryStore();
  const a = await ensureDeviceId(store);
  const b = await ensureDeviceId(store);
  assert.equal(a, b);
  assert.match(newDeviceId(), /^[A-Za-z0-9_-]{1,64}$/);
  const h = deviceHeaders(a, 3, 1_793_000_000_000);
  assert.deepEqual(parseDeviceHeaders(new Headers(h)), { deviceId: a, pending: 3, lastFlushAt: 1_793_000_000_000 });
  assert.deepEqual(parseDeviceHeaders(new Headers(deviceHeaders(a, 0, null))), { deviceId: a, pending: 0, lastFlushAt: null });
  assert.equal(deviceHeaders(a, 99_999, null)['X-Outbox-Pending'], '10000', 'не больше предела сервера');
});
