// Колонка доски и допустимые переносы (pipeline-v2 §2.1, §3.1). Колонки — как в пресете, синтетические ключи.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnOf, dropActions, isRecentlyClosed } from './board.js';
import type { BoardCard, BoardSpec, DealBooking, DropActor } from './board.js';
import { at } from './spec/vectors.js';

const BOARD: BoardSpec = {
  columns: [
    { key: 'fresh', states: ['new'] },
    { key: 'recall', states: ['retry', 'callback'] },
    { key: 'br', states: ['agreed'], eventTypes: ['group'] },
    { key: 'bk', states: ['agreed'], eventTypes: ['individual'] },
    { key: 'bought', states: ['client'] },
    { key: 'trash', states: ['not_interested', 'not_target', 'do_not_call', 'written_off'], recentDays: 30 },
  ],
  agreedFallback: 'br',
};

const card = (p: Partial<BoardCard>): BoardCard => ({ state: 'new', holdReason: '', ownerUserId: 'u-op-a', attempts: 0, closedAt: null, ...p });
const booking = (p: Partial<DealBooking>): DealBooking => ({ eventType: 'group', status: 'registered', dealIsOpen: true, ...p });

const OP: DropActor = { canOutcome: true, readOnly: false, scope: 'own' };
const LEAD: DropActor = { canOutcome: true, readOnly: false, scope: 'space' };

test('columnOf: состояния → колонки', () => {
  assert.equal(columnOf(card({ state: 'new' }), null, BOARD), 'fresh');
  assert.equal(columnOf(card({ state: 'retry' }), null, BOARD), 'recall');
  assert.equal(columnOf(card({ state: 'callback' }), null, BOARD), 'recall');
  assert.equal(columnOf(card({ state: 'client' }), null, BOARD), 'bought');
  for (const state of ['not_interested', 'not_target', 'do_not_call', 'written_off'] as const) {
    assert.equal(columnOf(card({ state }), null, BOARD), 'trash', state);
  }
});

test('columnOf: задержанные и новые без владельца на доске не показываются', () => {
  assert.equal(columnOf(card({ holdReason: 'dup_pair' }), null, BOARD), null);
  assert.equal(columnOf(card({ state: 'callback', holdReason: 'rule' }), null, BOARD), null);
  assert.equal(columnOf(card({ ownerUserId: null }), null, BOARD), null);
});

test('columnOf: agreed без записи — fallback; запись второго вида — вторая колонка; первого — первая', () => {
  const ag = card({ state: 'agreed' });
  assert.equal(columnOf(ag, null, BOARD), 'br');
  assert.equal(columnOf(ag, booking({ eventType: 'individual' }), BOARD), 'bk');
  assert.equal(columnOf(ag, booking({ eventType: 'group', status: 'attended' }), BOARD), 'br');
  assert.equal(columnOf(ag, booking({ eventType: 'individual', status: 'no_show' }), BOARD), 'bk');
});

test('columnOf: запись прежнего цикла или отменённая не учитывается', () => {
  const ag = card({ state: 'agreed' });
  assert.equal(columnOf(ag, booking({ eventType: 'individual', dealIsOpen: false }), BOARD), 'br');
  assert.equal(columnOf(ag, booking({ eventType: 'individual', status: 'cancelled' }), BOARD), 'br');
});

test('columnOf: вид записи не из колонок — fallback; без ключа fallback — колонка без видов или первая agreed', () => {
  const ag = card({ state: 'agreed' });
  assert.equal(columnOf(ag, booking({ eventType: 'other' }), BOARD), 'br');
  const noFb: BoardSpec = { columns: [{ key: 'one', states: ['agreed'] }] };
  assert.equal(columnOf(ag, null, noFb), 'one');
  assert.equal(columnOf(ag, null, { columns: [{ key: 'x', states: ['new'] }] }), null);
});

test('isRecentlyClosed: окно recentDays', () => {
  const trash = BOARD.columns[5]!;
  const now = at('2026-10-28 12:00');
  assert.equal(isRecentlyClosed({ closedAt: now - 29 * 86_400_000 }, trash, now), true);
  assert.equal(isRecentlyClosed({ closedAt: now - 31 * 86_400_000 }, trash, now), false);
  assert.equal(isRecentlyClosed({ closedAt: null }, trash, now), false);
  assert.equal(isRecentlyClosed({ closedAt: null }, BOARD.columns[0]!, now), true);
});

const targets = (c: BoardCard, a: DropActor, b: DealBooking | null = null) =>
  Object.fromEntries(dropActions(c, BOARD, a, b).map((t) => [t.column, t]));

test('dropActions: нет card.outcome или только чтение — целей нет', () => {
  assert.deepEqual(dropActions(card({}), BOARD, { ...OP, canOutcome: false }), []);
  assert.deepEqual(dropActions(card({}), BOARD, { canOutcome: true, readOnly: true, scope: 'space' }), []);
});

test('dropActions: из рабочих — перезвон, договорились, мусор; покупка только РОП; в «Новые» никому', () => {
  for (const state of ['new', 'retry', 'callback'] as const) {
    const t = targets(card({ state, attempts: 1 }), OP);
    assert.equal(t.fresh!.available, false);
    assert.equal(t.fresh!.blocked, state === 'new' ? 'same_column' : 'not_allowed');
    assert.deepEqual(t.bought!.blocked, 'rop_only');
    assert.deepEqual(t.br!.actions, ['outcome_agreed']);
    assert.deepEqual(t.bk!.actions, ['outcome_agreed']);
    assert.deepEqual(t.trash!.actions, ['outcome_close', 'write_off']);
    assert.equal(t.recall!.available, state === 'new');
  }
  const lead = targets(card({ state: 'callback' }), LEAD);
  assert.deepEqual(lead.bought!.actions, ['purchase_form']);
});

test('dropActions: № 32 оператору при attempts 0 погашено, при 1 и РОП — доступно', () => {
  assert.equal(targets(card({ state: 'new', attempts: 0 }), OP).trash!.writeOffAllowed, false);
  assert.equal(targets(card({ state: 'retry', attempts: 1 }), OP).trash!.writeOffAllowed, true);
  assert.equal(targets(card({ state: 'new', attempts: 0 }), LEAD).trash!.writeOffAllowed, true);
});

test('dropActions: из «Договорились» — запись другого вида, покупка РОП, мусор из меню; № 33 пока недоступен', () => {
  const ag = card({ state: 'agreed' });
  const t = targets(ag, OP, booking({ eventType: 'group' }));
  assert.equal(t.br!.blocked, 'same_column');
  assert.deepEqual(t.bk!.actions, ['booking_wizard']);
  assert.equal(t.bought!.blocked, 'rop_only');
  assert.deepEqual(t.trash!.actions, ['close_from_menu']);
  assert.deepEqual(t.trash!.onlyKinds, ['not_target', 'do_not_call']);
  assert.equal(t.recall!.available, false);
  assert.equal(t.recall!.blocked, 'pending_agreed_exit');
  assert.deepEqual(targets(ag, LEAD, booking({ eventType: 'individual' })).br!.actions, ['booking_wizard']);
});

test('dropActions: клиент — в перезвон нельзя, запись можно, мусор только «Не звонить»', () => {
  const t = targets(card({ state: 'client' }), LEAD);
  assert.equal(t.recall!.available, false);
  assert.deepEqual(t.br!.actions, ['booking_wizard']);
  assert.deepEqual(t.trash!.onlyKinds, ['do_not_call']);
  assert.equal(t.fresh!.available, false);
});

test('dropActions: из «Мусора» — только РОП и только в «Перезвон» (№ 14, № 15)', () => {
  const wo = targets(card({ state: 'written_off' }), LEAD);
  assert.deepEqual(wo.recall!.actions, ['reopen']);
  assert.equal(wo.br!.available, false);
  assert.equal(wo.bought!.available, false);
  assert.deepEqual(targets(card({ state: 'do_not_call' }), LEAD).recall!.actions, ['dnc_clear']);
  assert.equal(targets(card({ state: 'written_off' }), OP).recall!.blocked, 'rop_only');
});

test('dropActions: задержанная карточка не переносится', () => {
  const t = targets(card({ state: 'retry', holdReason: 'dup_pair' }), LEAD);
  assert.ok(Object.values(t).every((x) => !x.available));
});
