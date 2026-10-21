import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planActing, selectAbsenceCards, type AbsenceCardRow, type ActingCard } from './absence';

const END = 1_000_000;
const row = (over: Partial<AbsenceCardRow> & Pick<AbsenceCardRow, 'cardId' | 'state'>): AbsenceCardRow => ({
  clientId: `cl-${over.cardId}`,
  callsTotal: 1,
  nextCallAt: null,
  hasBookingInWindow: false,
  actingUserId: null,
  actingUntilDay: '',
  ...over,
});
const ids = (rs: AbsenceCardRow[]) => rs.map((r) => r.cardId);

test('перезвон и повтор со сроком раньше конца отсутствия — берём, включая уже наступившие', () => {
  const rs = [
    row({ cardId: 'a', state: 'callback', nextCallAt: END - 1 }),
    row({ cardId: 'b', state: 'retry', nextCallAt: 5 }),
    row({ cardId: 'c', state: 'callback', nextCallAt: END }),
    row({ cardId: 'd', state: 'retry', nextCallAt: END + 10 }),
    row({ cardId: 'e', state: 'callback', nextCallAt: null }),
  ];
  assert.deepEqual(ids(selectAbsenceCards(rs, END)), ['a', 'b']);
});

test('«Договорились» и «Клиент» — только с записью в окне', () => {
  const rs = [
    row({ cardId: 'a', state: 'agreed', hasBookingInWindow: true }),
    row({ cardId: 'b', state: 'client', hasBookingInWindow: true }),
    row({ cardId: 'c', state: 'agreed' }),
    row({ cardId: 'd', state: 'client' }),
  ];
  assert.deepEqual(ids(selectAbsenceCards(rs, END)), ['a', 'b']);
});

test('нетронутая новая — в пул; новая со звонками и закрытые не трогаются', () => {
  const rs = [
    row({ cardId: 'a', state: 'new', callsTotal: 0 }),
    row({ cardId: 'b', state: 'new', callsTotal: 2 }),
    row({ cardId: 'c', state: 'not_target' }),
    row({ cardId: 'd', state: 'do_not_call' }),
    row({ cardId: 'e', state: 'not_interested' }),
  ];
  assert.deepEqual(ids(selectAbsenceCards(rs, END)), ['a']);
});

test('замещавший коллегу: рабочие карточки переходят новому временному независимо от срока', () => {
  const rs = [
    row({ cardId: 'a', state: 'callback', nextCallAt: END * 5, actingUserId: 'u-x', actingUntilDay: '2026-10-30' }),
    row({ cardId: 'b', state: 'agreed', actingUserId: 'u-x', actingUntilDay: '2026-10-30' }),
    row({ cardId: 'c', state: 'written_off', actingUserId: 'u-x', actingUntilDay: '2026-10-30' }),
  ];
  assert.deepEqual(ids(selectAbsenceCards(rs, END)), ['a', 'b']);
});

const card = (cardId: string, groupKey = cardId, extra: Partial<ActingCard> = {}): ActingCard => ({ cardId, groupKey, ...extra });

test('заданный заместитель получает всё; срок прежний у замещаемых карточек', () => {
  const plan = planActing([card('a'), card('b', 'b', { untilDay: '2026-10-25' }), card('n', 'n', { release: true })], { substitute: 'u-b' }, '2026-10-30');
  assert.deepEqual(plan, [
    { cardId: 'n', action: 'release' },
    { cardId: 'a', action: 'acting', actingUserId: 'u-b', untilDay: '2026-10-30' },
    { cardId: 'b', action: 'acting', actingUserId: 'u-b', untilDay: '2026-10-25' },
  ]);
});

test('«поровну»: 7 карточек на 3 кандидата с нагрузкой 0/2/0 → 3/1/3', () => {
  const cards = Array.from({ length: 7 }, (_, i) => card(`c${i}`));
  const plan = planActing(cards, { even: [{ userId: 'u1', load: 0 }, { userId: 'u2', load: 2 }, { userId: 'u3', load: 0 }] }, '2026-10-30');
  const per = new Map<string, number>();
  for (const a of plan) per.set(a.actingUserId!, (per.get(a.actingUserId!) ?? 0) + 1);
  assert.deepEqual([per.get('u1'), per.get('u2'), per.get('u3')], [3, 1, 3]);
});

test('«поровну»: группа из трёх двойников не делится', () => {
  const cards = [card('a', 'g'), card('b', 'g'), card('c', 'g'), card('d')];
  const plan = planActing(cards, { even: [{ userId: 'u1', load: 0 }, { userId: 'u2', load: 0 }] }, '2026-10-30');
  const owner = (id: string) => plan.find((p) => p.cardId === id)?.actingUserId;
  assert.equal(owner('a'), owner('b'));
  assert.equal(owner('b'), owner('c'));
  assert.notEqual(owner('d'), owner('a'));
});

test('«поровну»: равная нагрузка — по порядку кандидатов; повтор плана даёт то же', () => {
  const who = { even: [{ userId: 'u1', load: 1 }, { userId: 'u2', load: 1 }] };
  const p1 = planActing([card('a'), card('b')], who, '2026-10-30');
  assert.deepEqual(p1.map((p) => p.actingUserId), ['u1', 'u2']);
  assert.deepEqual(planActing([card('a'), card('b')], who, '2026-10-30'), p1);
});

test('пустой список кандидатов — временных нет, нетронутые новые всё равно в пул', () => {
  const plan = planActing([card('a'), card('n', 'n', { release: true })], { even: [] }, '2026-10-30');
  assert.deepEqual(plan, [{ cardId: 'n', action: 'release' }]);
  assert.deepEqual(planActing([card('a')], { even: [] }, '2026-10-30'), []);
});
