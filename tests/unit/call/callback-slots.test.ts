// Слоты времени перезвона: список HH:mm шагом 15 минут в окне звонков установки, 24 часа (D-358 п. 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotLabel, timeSlots } from '../../../src/ui/call/callbackSlots';

test('окно 09:00–18:00: первый слот 09:00, последний 18:00, шаг 15 минут', () => {
  const s = timeSlots('09:00', '18:00');
  assert.equal(s[0], '09:00');
  assert.equal(s.at(-1), '18:00');
  assert.equal(s.length, 37);
  assert.equal(s[1], '09:15');
});

test('границы окна не выходят: слот после конца окна не добавляется, начало не по сетке сохраняется', () => {
  assert.deepEqual(timeSlots('09:10', '09:50'), ['09:10', '09:25', '09:40']);
  assert.deepEqual(timeSlots('10:00', '10:00'), ['10:00']);
});

test('пустое или перевёрнутое окно — пустой список, мусор не падает', () => {
  assert.deepEqual(timeSlots('18:00', '09:00'), []);
  assert.deepEqual(timeSlots('xx', '09:00'), []);
});

test('текущее значение вне сетки добавляется в список, чтобы выбор не терялся', () => {
  const s = timeSlots('09:00', '10:00', 15, '09:07');
  assert.ok(s.includes('09:07'));
  assert.deepEqual([...s].sort(), s);
});

test('подпись слота — 24 часа без AM/PM при любой локали', () => {
  for (const hh of ['00:00', '09:00', '13:45', '23:59']) {
    const label = slotLabel(hh);
    assert.equal(label, hh);
    assert.ok(!/AM|PM|a\.m|p\.m/i.test(label));
  }
});
