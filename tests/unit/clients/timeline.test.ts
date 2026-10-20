// Реестр видов событий ленты: группы, виды групп, отбор ключей data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_KINDS, FEED_GROUPS, groupOf, isKnownKind, kindsOfGroups, pickData } from '../../../src/server/domain/timeline/kinds';
import { DESCRIBED_KINDS } from '../../../src/app/(op)/clients/_ui/feedLabels';

test('у каждого вида есть известная группа и подпись интерфейса', () => {
  const messages = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'messages', 'ru', 'clients.json'), 'utf8')) as {
    feed: { kinds: Record<string, string>; group: Record<string, string> };
  };
  for (const [kind, spec] of Object.entries(EVENT_KINDS)) {
    assert.ok(FEED_GROUPS.includes(spec.group), kind);
    assert.ok((DESCRIBED_KINDS as readonly string[]).includes(kind), `нет подписи вида ${kind} в feedLabels`);
  }
  assert.deepEqual([...DESCRIBED_KINDS].sort(), Object.keys(EVENT_KINDS).sort());
  for (const g of FEED_GROUPS) assert.ok(messages.feed.group[g], `нет подписи группы ${g}`);
  for (const key of ['fieldChanged', 'contactFieldChanged', 'phone_added', 'phone_not_working', 'phone_primary', 'contact_added', 'contact_archived', 'call', 'call_voided', 'note_created', 'unknown', 'card_created', 'card_state', 'card_assigned', 'card_released', 'card_transferred', 'card_acting', 'card_merged', 'dnc_set', 'dnc_cleared', 'import_row', 'client_created', 'task_created', 'task_done', 'task_cancelled', 'task_comment']) {
    assert.ok(messages.feed.kinds[key], `нет сообщения feed.kinds.${key}`);
  }
});

test('виды выбранных групп; без групп — все', () => {
  assert.deepEqual(kindsOfGroups(null).sort(), Object.keys(EVENT_KINDS).sort());
  assert.deepEqual(kindsOfGroups([]).sort(), Object.keys(EVENT_KINDS).sort());
  assert.deepEqual(kindsOfGroups(['notes']), ['note.created']);
  assert.deepEqual(kindsOfGroups(['calls']).sort(), ['call', 'call.voided']);
  assert.ok(kindsOfGroups(['system']).includes('field.changed'));
});

test('вид не из реестра: нет группы, data пустая', () => {
  assert.equal(isKnownKind('x.unknown'), false);
  assert.equal(groupOf('x.unknown'), null);
  assert.deepEqual(pickData('x.unknown', { secret: 1 }), {});
  assert.equal(groupOf('phone.added'), 'system');
});

test('data режется до ключей вида', () => {
  assert.deepEqual(pickData('phone.added', { phoneId: 'p', digits: '7709', extra: 1 }), { phoneId: 'p' });
  assert.deepEqual(pickData('field.changed', { obj: 'client', sys: false, field: 'f', before: 1, after: 2, hidden: 'x' }), {
    obj: 'client',
    sys: false,
    field: 'f',
    before: 1,
    after: 2,
  });
  assert.deepEqual(pickData('phone.added', null), {});
  assert.deepEqual(pickData('phone.added', ['x']), {});
});

test('import.row: сырой текст ячейки (answerRaw) и служебные ключи в ленту не отдаются', () => {
  const data = { importId: 'i1', rowNo: 3, rowKey: 'ext-1', stateKey: 'abc', action: 'create', outcomeKey: 'callback', answerRaw: 'Иван просил набрать +7 709 000 00 00' };
  assert.deepEqual(pickData('import.row', data), { importId: 'i1', rowNo: 3, action: 'create', outcomeKey: 'callback' });
  assert.deepEqual(pickData('card.state', { fromState: 'new', toState: 'agreed', cause: 'x', phone: '7709' }), { fromState: 'new', toState: 'agreed', cause: 'x' });
});
