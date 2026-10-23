// Куда можно перенести плитку, какой канал у итога, блокировка плиток из очереди устройства (pipeline-v2 §3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMoveRequest, callBlockedBy, canMoveAnywhere, lockedIds, moreTrash, moveTargets, planFor, quickTrash, viaFor, writeOffBlocked } from '@/ui/board/moves';
import { EMPTY_DRAFT } from '@/ui/call/types';
import { CALL, COLUMNS, CONFIG, OUTCOMES, card } from './fixtures';

const trash = COLUMNS.find((c) => c.key === 'trash')!;
const byKey = (xs: ReturnType<typeof moveTargets>) => Object.fromEntries(xs.map((t) => [t.column, t]));

test('из «Новые»: в «Перезвон» и «Мусор» можно, остальные колонки до этапа В погашены', () => {
  const t = byKey(moveTargets(card({ column: 'new' }), COLUMNS, true));
  assert.equal(t.callback?.available, true);
  assert.equal(t.callback?.action, 'callback');
  assert.equal(t.trash?.available, true);
  assert.equal(t.trash?.action, 'trash');
  assert.equal(t.meet?.available, false);
  assert.equal(t.meet?.blocked, 'later');
  assert.equal(t.paid?.available, false);
  assert.equal(t.new?.blocked, 'same');
});

test('из «Перезвон»: в «Новые» нельзя никому, в «Мусор» можно', () => {
  const t = byKey(moveTargets(card({ column: 'callback', state: 'callback' }), COLUMNS, true));
  assert.equal(t.new?.available, false);
  assert.equal(t.callback?.blocked, 'same');
  assert.equal(t.trash?.available, true);
});

test('плитки «Договорились», «Покупка» и «Мусор» не переносятся (этап В): целей нет', () => {
  for (const column of ['meet', 'paid', 'trash']) {
    const ts = moveTargets(card({ column, state: 'agreed' }), COLUMNS, true);
    assert.equal(canMoveAnywhere(ts), false, column);
  }
});

test('нет права переноса (директор, только чтение): целей нет вовсе', () => {
  const ts = moveTargets(card({ column: 'new' }), COLUMNS, false);
  assert.equal(canMoveAnywhere(ts), false);
  assert.ok(ts.every((t) => t.blocked === 'viewer'));
});

test('плитка вне колонок доски (поиск нашёл задержанную) не переносится', () => {
  assert.equal(canMoveAnywhere(moveTargets(card({ column: null }), COLUMNS, true)), false);
});

test('плитки с итогом в очереди устройства или в окне «Отменить» заблокированы', () => {
  const s = lockedIds(['a', 'b'], ['c']);
  assert.ok(s.has('a') && s.has('b') && s.has('c'));
  assert.ok(!s.has('d'));
});

test('канал итога: намерение звонка — ui/offline, без намерения — board', () => {
  assert.equal(viaFor(true, true), 'ui');
  assert.equal(viaFor(true, false), 'offline');
  assert.equal(viaFor(false, true), 'board');
  assert.equal(viaFor(false, false), 'board');
});

const draft = { ...EMPTY_DRAFT, outcomeKey: 'callback', reasonCode: 'think', callbackAt: 1_000_000, callbackPrecision: 'day' as const, lpr: 'yes' as const };

test('запрос переноса без звонка: канал board, opId с устройства, момент нажатия не передаётся', () => {
  const req = buildMoveRequest({ card: card(), def: OUTCOMES[1]!, draft, intent: null, opId: 'op-new', now: 5, online: true, callbackV2: true });
  assert.equal(req.via, 'board');
  assert.equal(req.opId, 'op-new');
  assert.equal(req.tappedAt, null);
  assert.equal(req.cardId, 'card-1');
  assert.equal(req.reasonCode, 'think');
  assert.equal(req.callbackAt, 1_000_000);
  assert.equal(req.callbackPrecision, 'day');
});

test('запрос переноса после «Позвонить»: opId и момент нажатия из намерения, канал ui; без сети — offline', () => {
  const intent = { opId: 'op-call', tappedAt: 777 };
  const on = buildMoveRequest({ card: card(), def: OUTCOMES[1]!, draft, intent, opId: 'ignored', now: 9, online: true, callbackV2: true });
  assert.deepEqual([on.via, on.opId, on.tappedAt], ['ui', 'op-call', 777]);
  const off = buildMoveRequest({ card: card(), def: OUTCOMES[0]!, draft: { ...EMPTY_DRAFT, outcomeKey: 'no_answer' }, intent, opId: 'ignored', now: 9, online: false, callbackV2: true });
  assert.equal(off.via, 'offline');
});

test('«Мусор»: быстрые причины в порядке пресета, «Не отвечает» погашено оператору при attempts 0 и открыто после недозвона', () => {
  const quick = quickTrash(trash, CALL, CONFIG.writeOffReasons, card({ attempts: 0 }), 'own');
  assert.deepEqual(quick.map((c) => c.label), ['Закрыл компанию', 'Не нужны услуги', 'Не отвечает']);
  const wo = quick[2]!;
  assert.equal(wo.kind === 'write_off' && wo.blocked, 'call_first');
  assert.equal(writeOffBlocked(card({ attempts: 1 }), 'own'), null);
  assert.equal(writeOffBlocked(card({ attempts: 0 }), 'wide'), null);
});

test('«Другие причины…»: остальные ручные причины видов, без дублей быстрых; без dropMore — пусто', () => {
  const more = moreTrash(trash, CALL, CONFIG.writeOffReasons, card(), 'own');
  const ids = more.map((c) => `${c.kind === 'outcome' ? c.outcomeKind : 'written_off'}:${c.reason}`);
  assert.deepEqual(ids, ['not_interested:later', 'not_interested:other', 'written_off:other']);
  assert.deepEqual(moreTrash({ ...trash, dropMore: false }, CALL, CONFIG.writeOffReasons, card(), 'own'), []);
});

test('неизвестная пара drop (вид без кнопки итога) пропускается, а не ломает окно', () => {
  const col = { ...trash, drop: [{ kind: 'unknown_kind', reason: 'x', label: 'x' }] };
  assert.deepEqual(quickTrash(col, CALL, [], card(), 'own'), []);
});

test('раскладка «в уме»: перезвон — в «Перезвон» с причиной и касанием, «Не берёт» — недозвон, отказ — в «Мусор»', () => {
  const c = card({ attempts: 1, callbackTouches: 1 });
  const cb = planFor(c, { kind: 'callback' }, draft, COLUMNS, 10);
  assert.equal(cb?.column, 'callback');
  assert.equal(cb?.patch.callbackReason, 'think');
  assert.equal(cb?.patch.callbackTouches, 2);
  assert.equal(cb?.patch.nextCallPrecision, 'day');
  const na = planFor(c, { kind: 'no_answer' }, draft, COLUMNS, 10);
  assert.deepEqual([na?.column, na?.patch.state, na?.patch.attempts], ['callback', 'retry', 2]);
  const ni = planFor(c, { kind: 'not_interested' }, { ...draft, reasonCode: 'no_need' }, COLUMNS, 10);
  assert.deepEqual([ni?.column, ni?.patch.state, ni?.patch.closeReasonCode], ['trash', 'not_interested', 'no_need']);
  assert.equal(planFor(c, { kind: 'agreed' }, draft, COLUMNS, 10), null);
  assert.equal(planFor(c, { kind: 'bad_number' }, draft, COLUMNS, 10), null);
});

// ---------- РОП (охват wide): итоги с доски сервер не принимает ----------

test('РОП (wide): «Перезвон» погашен, в «Мусор» остаётся только ручное списание, а не итог через board', () => {
  const t = byKey(moveTargets(card({ column: 'new' }), COLUMNS, true, 'wide'));
  assert.equal(t.callback?.available, false);
  assert.equal(t.callback?.blocked, 'manual');
  assert.equal(t.trash?.available, true);
  const quick = quickTrash(trash, CALL, [{ key: 'unreachable', label: 'Не отвечает', needsText: false }], card(), 'wide');
  assert.ok(quick.length > 0 && quick.every((c) => c.kind === 'write_off'), 'быстрые причины РОП — только списание');
  const more = moreTrash(trash, CALL, [{ key: 'unreachable', label: 'Не отвечает', needsText: false }, { key: 'dup', label: 'Дубль', needsText: false }], card(), 'wide');
  assert.ok(more.every((c) => c.kind === 'write_off'), 'и в «Других причинах» итогов нет');
});

test('оператор (own): «Перезвон» доступен; канал board без намерения звонка, у РОП намерения не бывает', () => {
  assert.equal(byKey(moveTargets(card({ column: 'new' }), COLUMNS, true, 'own')).callback?.available, true);
  assert.equal(viaFor(false, true), 'board');
});

test('«Мусор»: «Полный отказ» (do_not_call) доступен оператору в «Других причинах» и как быстрая пара пресета', () => {
  const call = { ...CALL, outcomes: [...CALL.outcomes, { key: 'do_not_call', kind: 'do_not_call' as const, label: 'Полный отказ', color: 'x', requires: { lpr: false, reason: true, callbackAt: false, contact: false, agreement: false, fields: [] as string[] }, reasons: [{ key: 'asked', label: 'Просил не звонить', needsText: false }] }] };
  const col = { ...trash, drop: [...trash.drop, { kind: 'do_not_call', reason: 'asked', label: 'Просил не звонить' }] };
  const quick = quickTrash(col, call, [], card(), 'own');
  assert.ok(quick.some((c) => c.kind === 'outcome' && c.outcomeKind === 'do_not_call' && c.reason === 'asked'));
  const more = moreTrash({ ...trash, drop: [] }, call, [], card(), 'own');
  assert.ok(more.some((c) => c.kind === 'outcome' && c.outcomeKind === 'do_not_call'));
});

test('«Позвонить» на другой плитке погашено, пока висит намерение звонка; своя плитка рабочая', () => {
  assert.equal(callBlockedBy(null, 'b'), false);
  assert.equal(callBlockedBy('a', 'a'), false);
  assert.equal(callBlockedBy('a', 'b'), true);
});
