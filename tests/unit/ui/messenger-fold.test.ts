// Сворачивание сообщений ленты по дням (PROCESS 9.1): подряд идущие сообщения одного местного дня — одна группа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldMessages } from '../../../src/ui/messenger/fold';

const TZ = 'Asia/Almaty';
const at = (iso: string): number => Date.parse(iso);
const item = (id: string, kind: string, iso: string) => ({ id, kind, at: at(iso) });

test('сообщения одного дня сворачиваются, другой день и чужие события разрывают серию', () => {
  const items = [
    item('m4', 'message', '2026-10-28T10:00:00+05:00'),
    item('m3', 'message', '2026-10-28T09:00:00+05:00'),
    item('c1', 'call', '2026-10-28T08:00:00+05:00'),
    item('m2', 'message', '2026-10-28T07:00:00+05:00'),
    item('m1', 'message', '2026-10-27T23:30:00+05:00'),
  ];
  const out = foldMessages(items, TZ);
  assert.deepEqual(out.map((e) => (e.kind === 'item' ? e.item.id : e.items.map((i) => i.id).join('+'))), ['m4+m3', 'c1', 'm2', 'm1']);
});

test('граница суток считается в поясе установки, а не UTC', () => {
  // 23:30 и 00:30 по Алматы — разные сутки, хотя в UTC (18:30 и 19:30) день один
  const out = foldMessages([item('b', 'message', '2026-10-28T00:30:00+05:00'), item('a', 'message', '2026-10-27T23:30:00+05:00')], TZ);
  assert.equal(out.length, 2);
  assert.equal(foldMessages([item('b', 'message', '2026-10-28T00:30:00+05:00'), item('a', 'message', '2026-10-28T00:10:00+05:00')], TZ).length, 1);
});

test('«открыт WhatsApp» входит в серию сообщений; без сообщений лента не меняется', () => {
  const out = foldMessages([item('o', 'messenger.link_opened', '2026-10-28T10:00:00+05:00'), item('m', 'message', '2026-10-28T09:00:00+05:00')], TZ);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.kind, 'messages');
  const plain = foldMessages([item('x', 'call', '2026-10-28T10:00:00+05:00'), item('y', 'note.created', '2026-10-28T09:00:00+05:00')], TZ);
  assert.deepEqual(plain.map((e) => e.kind), ['item', 'item']);
});
