// Таблица источников задач (D-253, docs/tasks-team-design.md §4.2): проекции срока и инварианты вручную не закрываются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSABLE_SOURCES, SOURCE_RULES, TASK_SOURCES, isClosable } from '../../../src/server/domain/tasks/sources';

test('каждый источник схемы описан ровно одной строкой', () => {
  const schema = [
    'manual', 'callback', 'no_show', 'rebook', 'inbound_message', 'missed_call', 'handoff', 'grey_unassigned', 'dnc_inbound',
    'review', 'proposal', 'attendance_mark', 'next_step', 'agreement', 'clarify_import', 'absent_review', 'staff_disabled', 'stoplist_confirm',
  ];
  assert.deepEqual([...TASK_SOURCES].sort(), [...schema].sort());
});

test('проекции и инварианты не закрываются, переход — к действию, которое их закроет', () => {
  const expect: Record<string, string> = {
    callback: 'openCard', no_show: 'openCard', rebook: 'openCard', clarify_import: 'openCard',
    agreement: 'book', next_step: 'book', attendance_mark: 'openEvent', handoff: 'openHandoff', grey_unassigned: 'bookings',
  };
  for (const [source, action] of Object.entries(expect)) {
    assert.equal(isClosable(source), false, source);
    assert.equal(SOURCE_RULES[source as keyof typeof SOURCE_RULES].action, action, source);
  }
});

test('ручные и задачи разбора закрываются «Готово»', () => {
  for (const s of ['manual', 'inbound_message', 'missed_call', 'dnc_inbound', 'review', 'proposal', 'absent_review', 'staff_disabled', 'stoplist_confirm']) {
    assert.equal(isClosable(s), true, s);
    assert.ok(CLOSABLE_SOURCES.includes(s as never), s);
  }
  assert.equal(CLOSABLE_SOURCES.length, 9);
  assert.equal(isClosable('нет такого'), false);
  assert.equal(isClosable('toString'), false);
});
