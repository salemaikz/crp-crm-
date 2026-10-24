// Что показывает плитка: тон по пресету, значки, чип и срок (pipeline-v2 §5.3, §9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendControls } from '@/ui/board/attend';
import type { ColumnRole } from '@/ui/board/types';
import { chipOf, closeReasonLabel, dueOf, hasFire, overdueParts, reasonLabel, tileBadge, tileRows, tileValues, toneOf, type TileCtx } from '@/ui/board/tile';
import { CONFIG, OUTCOMES, card } from './fixtures';

const TONES = [
  { when: 'attendedIndividual', tone: 'warning' },
  { when: 'attendedGroup', tone: 'success' },
];

test('тон плитки: был на встрече — зелёный, был на консультации — жёлтый (из пресета)', () => {
  assert.equal(toneOf(card({ flags: { attendedGroup: true, attendedIndividual: false, noShow: false } }), TONES), 'success');
  assert.equal(toneOf(card({ flags: { attendedGroup: false, attendedIndividual: true, noShow: false } }), TONES), 'warning');
});

test('тон: действует первое совпадение; без признаков и без пресета цвета нет', () => {
  const both = card({ flags: { attendedGroup: true, attendedIndividual: true, noShow: false } });
  assert.equal(toneOf(both, TONES), 'warning');
  assert.equal(toneOf(card(), TONES), null);
  assert.equal(toneOf(both, []), null);
});

test('тон: неизвестное имя тона и неизвестное условие пропускаются; покупка — только если сервер прислал признак', () => {
  const att = card({ flags: { attendedGroup: true, attendedIndividual: false, noShow: false } });
  assert.equal(toneOf(att, [{ when: 'attendedGroup', tone: '#ff0000' }, { when: 'wat', tone: 'info' }]), null);
  assert.equal(toneOf(card({ purchases: { total: 1, lastAt: 1, lastAmountKzt: null } }), [{ when: 'purchased', tone: 'info' }]), 'info');
  assert.equal(toneOf(card(), [{ when: 'purchased', tone: 'info' }]), null);
});

const BEHAVIORS = CONFIG.eventBehaviors;
const NOW = 10 * 3_600_000;
const booking = (over: Partial<NonNullable<ReturnType<typeof card>['event']>> = {}) => ({ type: 'meet', status: 'registered', startsAt: NOW - 3_600_000, bookingId: 'bk-1', bookingVersion: 0, ...over });
const FLAGS_NONE = { attendedGroup: false, attendedIndividual: false, noShow: false };

test('тон = значку = тумблеру: явка по записи в статусе «пришёл» красит плитку, даже если флаг карточки не выставлен', () => {
  const c = card({ state: 'agreed', event: booking({ status: 'attended' }), flags: FLAGS_NONE });
  assert.equal(toneOf(c, TONES), null, 'без вида записи тон не считается');
  assert.equal(toneOf(c, TONES, BEHAVIORS), 'success');
  const controls = attendControls(c, { canAttend: false, eventBehaviors: BEHAVIORS }, NOW);
  assert.deepEqual(controls.map((x) => [x.kind, x.mode, x.view.on]), [['attendedGroup', 'badge', true]]);
  assert.deepEqual(tileBadge(c, controls, []), { id: 'attended', kinds: ['attendedGroup'] });
  const withRight = attendControls(c, { canAttend: true, eventBehaviors: BEHAVIORS }, NOW);
  assert.equal(withRight[0]?.view.on, true, 'и у того, кто вправе отмечать, тумблер включён по той же функции');
});

test('без права явки тумблера нет: признак — значок, признака нет — ничего', () => {
  const op = { canAttend: false, eventBehaviors: BEHAVIORS };
  assert.deepEqual(attendControls(card({ state: 'agreed', event: booking() }), op, NOW), []);
  assert.equal(attendControls(card({ flags: { ...FLAGS_NONE, attendedIndividual: true } }), op, NOW)[0]?.mode, 'badge');
  assert.equal(attendControls(card({ state: 'agreed', event: booking() }), { canAttend: true, eventBehaviors: BEHAVIORS }, NOW)[0]?.mode, 'toggle');
});

test('один значок: «Был», иначе «Не пришёл», иначе «Покупал»; «Не пришёл» молчит, если чип уже говорит причиной неявки', () => {
  const noShow = card({ state: 'callback', callbackReason: 'no_show_meet', flags: { ...FLAGS_NONE, noShow: true }, purchases: { total: 1, lastAt: 1, lastAmountKzt: null } });
  assert.equal(tileBadge(noShow, [], ['no_show_meet'])?.id, 'purchased', 'неявка уже в чипе - остаётся покупка');
  assert.equal(tileBadge(noShow, [], [])?.id, 'noShow');
  assert.equal(tileBadge(card({ purchases: { total: 2, lastAt: 5, lastAmountKzt: null } }), [], [])?.id, 'purchased');
  assert.equal(tileBadge(card({ purchases: { total: 0, lastAt: null, lastAmountKzt: null } }), [], []), null);
  assert.equal(tileBadge(card(), [], []), null);
});

test('чип: причина и касание, недозвон, запись, состояние; у нового клиента чипа нет', () => {
  assert.deepEqual(chipOf(card({ state: 'callback', callbackReason: 'think', callbackTouches: 2 })), { kind: 'reason', reason: 'think', touches: 2 });
  assert.deepEqual(chipOf(card({ state: 'retry', attempts: 2 })), { kind: 'attempts', n: 2 });
  assert.deepEqual(chipOf(card({ state: 'agreed', event: { type: 'g', status: 'registered', startsAt: 5, bookingId: 'b1', bookingVersion: 0 } })), { kind: 'event', type: 'g', status: 'registered', startsAt: 5 });
  assert.deepEqual(chipOf(card({ state: 'callback' })), { kind: 'state', state: 'callback' });
  assert.deepEqual(chipOf(card({ state: 'client' })), { kind: 'state', state: 'client' });
  assert.deepEqual(chipOf(card()), { kind: 'none' });
});

test('срок: просрочка и «сегодня» берутся от сервера, «без времени» сохраняется', () => {
  const now = 10 * 3_600_000;
  assert.deepEqual(dueOf(card(), now), { kind: 'none' });
  assert.deepEqual(dueOf(card({ nextCallAt: now - 2 * 3_600_000, fire: 'overdue' }), now), { kind: 'overdue', precision: 'time', at: now - 7_200_000, minutes: 120 });
  assert.equal(dueOf(card({ nextCallAt: now + 1, fire: 'today', nextCallPrecision: 'day' }), now).kind, 'today');
  assert.equal(dueOf(card({ nextCallAt: now + 1e9, fire: null }), now).kind, 'later');
});

test('огонёк: сегодня и просрочено; остальное без огонька', () => {
  assert.equal(hasFire(card({ fire: 'today' })), true);
  assert.equal(hasFire(card({ fire: 'overdue' })), true);
  assert.equal(hasFire(card({ fire: null })), false);
});

test('просрочка словами: минуты, часы, дни', () => {
  assert.deepEqual(overdueParts(35), { unit: 'min', n: 35 });
  assert.deepEqual(overdueParts(120), { unit: 'hour', n: 2 });
  assert.deepEqual(overdueParts(60 * 24 * 3), { unit: 'day', n: 3 });
});

test('причина перезвона: подпись из справочника; кода нет в справочнике — null, а не сырой ключ', () => {
  const labels = { thinking: 'Думает', empty: ' ' };
  assert.equal(reasonLabel(labels, 'thinking'), 'Думает');
  assert.equal(reasonLabel(labels, 'busy'), null);
  assert.equal(reasonLabel(labels, 'empty'), null);
  assert.equal(reasonLabel(labels, 'constructor'), null, 'ключи прототипа не считаются подписями');
});

// ---------- Строки плитки (ui-polish §9.3) ----------

const ctxOf = (role: ColumnRole, scope: 'own' | 'wide', over: Partial<TileCtx> = {}): TileCtx => ({
  role,
  scope,
  canCall: scope === 'own',
  config: { canAttend: false, eventBehaviors: BEHAVIORS, agreedExit: CONFIG.agreedExit },
  now: NOW,
  tileFields: [{ key: 'niche', label: 'Сфера', options: { shop: 'Магазин' } }, { key: 'city', label: 'Город', options: {} }, { key: 'size', label: 'Размер', options: {} }],
  closeLabel: (c) => closeReasonLabel(c, OUTCOMES, CONFIG.writeOffReasons),
  ...over,
});

const FULL = card({
  lprName: 'Асель Синтетик',
  state: 'callback',
  callbackReason: 'think',
  callbackTouches: 1,
  nextCallAt: NOW + 1000,
  fire: 'today',
  values: { niche: 'shop', city: 'Астана', size: '10' },
  flags: { ...FLAGS_NONE, attendedGroup: true },
  purchases: { total: 1, lastAt: 1, lastAmountKzt: 1000 },
});

test('плитка: не больше четырёх строк в каждой роли колонки и охвате; на ноутбуке «Позвонить» в первой строке — не больше трёх', () => {
  const roles: ColumnRole[] = ['new', 'callback', 'agreed', 'client', 'trash', 'other'];
  for (const role of roles) {
    for (const scope of ['own', 'wide'] as const) {
      const c = card({ ...FULL, ownerName: scope === 'wide' ? 'Айгерим Синтетик' : undefined } as never);
      for (const layout of ['phone', 'laptop'] as const) {
        const r = tileRows(c, ctxOf(role, scope), layout);
        assert.ok(r.count <= 4, `${role}/${scope}/${layout}: ${r.count}`);
        if (layout === 'laptop') assert.ok(r.count <= 3, `${role}/${scope}/laptop: ${r.count}`);
      }
    }
  }
});

test('доска пространства (wide) без кнопок: не больше трёх строк, четвёртой строки нет', () => {
  for (const role of ['new', 'callback', 'agreed'] as const) {
    const r = tileRows(card({ ...FULL, ownerName: 'Айгерим Синтетик' } as never), ctxOf(role, 'wide'), 'phone');
    assert.equal(r.actions, false, role);
    assert.ok(r.count <= 3, `${role}: ${r.count}`);
  }
});

test('строка без содержимого не выводится: у нового клиента без полей есть только название и номер', () => {
  const r = tileRows(card({ phone: { id: 'p', masked: '+7 709 ••• •• 01', kind: 'mobile' } }), ctxOf('new', 'wide'), 'phone');
  assert.deepEqual([r.meta, r.contact, r.actions, r.count], [false, true, false, 2]);
  const noPhone = tileRows(card({ phone: null }), ctxOf('new', 'wide'), 'phone');
  assert.deepEqual([noPhone.meta, noPhone.contact, noPhone.count], [false, false, 1]);
});

test('кнопки: четвёртая строка только у своих карточек с номером и только на телефоне', () => {
  const c = card({ lprName: 'Асель Синтетик' });
  assert.equal(tileRows(c, ctxOf('new', 'own'), 'phone').actions, true);
  assert.equal(tileRows(c, ctxOf('new', 'own'), 'laptop').actions, false);
  assert.equal(tileRows(c, ctxOf('new', 'wide'), 'phone').actions, false);
  assert.equal(tileRows(card({ phone: null }), ctxOf('new', 'own'), 'phone').actions, false, 'без номера кнопки нет');
  assert.equal(tileRows(c, ctxOf('new', 'own', { canCall: false }), 'phone').actions, false, 'без права на итог звонить нельзя');
});

test('конечные колонки: компактно — название и одна строка «сумма · дата» / «причина · дата», без контактов и кнопок', () => {
  const buyer = card({ state: 'client', purchases: { total: 1, lastAt: 5, lastAmountKzt: 150000 }, lprName: 'Асель Синтетик' });
  const r = tileRows(buyer, ctxOf('client', 'own'), 'phone');
  assert.deepEqual([r.meta, r.contact, r.actions, r.count], [true, false, false, 2]);
  // без права на покупки строки «сумма · дата» нет вовсе
  assert.equal(tileRows(card({ state: 'client' }), ctxOf('client', 'own'), 'phone').meta, false);
  const closed = card({ state: 'not_interested', closedAt: 5, closeReasonCode: 'no_need' });
  assert.equal(tileRows(closed, ctxOf('trash', 'own'), 'phone').count, 2);
});

test('значения полей «Новых»: не больше двух, пустые пропускаются, вариант списка — подписью', () => {
  const fields = ctxOf('new', 'own').tileFields;
  assert.deepEqual(tileValues(card({ values: { niche: 'shop', city: 'Астана', size: '10' } }), fields), ['Магазин', 'Астана']);
  assert.deepEqual(tileValues(card({ values: { niche: '', city: 'Астана', size: '10' } }), fields), ['Астана', '10']);
  assert.deepEqual(tileValues(card({ values: {} }), fields), []);
  assert.deepEqual(tileValues(card({ values: { niche: 'shop', city: 'Астана' } }), fields, 1), ['Магазин']);
});

test('причина закрытия: подпись по виду итога и причине; кода нет — пусто, а не сырой ключ', () => {
  assert.equal(closeReasonLabel(card({ state: 'not_interested', closeReasonCode: 'no_need' }), OUTCOMES, CONFIG.writeOffReasons), 'Не нужны услуги');
  assert.equal(closeReasonLabel(card({ state: 'not_target', closeReasonCode: 'closed' }), OUTCOMES, CONFIG.writeOffReasons), 'Закрыл компанию');
  assert.equal(closeReasonLabel(card({ state: 'written_off', closeReasonCode: 'unreachable' }), OUTCOMES, CONFIG.writeOffReasons), 'Не отвечает');
  assert.equal(closeReasonLabel(card({ state: 'not_interested', closeReasonCode: 'zzz' }), OUTCOMES, CONFIG.writeOffReasons), '');
  assert.equal(closeReasonLabel(card({ state: 'do_not_call', closeReasonCode: '' }), OUTCOMES, CONFIG.writeOffReasons), '');
});

test('ряд действий только в рабочих колонках: у «Договорились» и конечных его нет', () => {
  const c = card({ lprName: 'Асель Синтетик' });
  for (const role of ['agreed', 'client', 'trash', 'other'] as const) assert.equal(tileRows(c, ctxOf(role, 'own'), 'phone').actions, false, role);
  assert.equal(tileRows(c, ctxOf('callback', 'own'), 'phone').actions, true);
});

// ---------- D-358 п. 2, 7: полоса тона и шум статуса ----------
import { toneStyle } from '@/ui/board/tileStyle';
import { eventStatusKey, contactDot } from '@/ui/board/tile';

test('полоса тона — inset-тень 6 px, а не рамка: левая граница текста одинакова у белых и цветных плиток', () => {
  const styles = [null, 'neutral', 'success', 'warning', 'info', 'danger'].map((t) => toneStyle(t as never));
  const widths = new Set(styles.map((s) => s.borderLeftWidth ?? s.borderWidth ?? 1));
  assert.equal(widths.size, 1, 'ширина рамки у всех плиток одна');
  for (const s of styles.slice(1)) assert.match(String(s.boxShadow), /inset 6px 0 0/);
  assert.equal(styles[0]!.boxShadow, undefined);
});

test('статус записи на плитке: «Не подтвердил» не пишется, «Подтвердил» и «Не пришёл» — да', () => {
  assert.equal(eventStatusKey('registered'), null);
  assert.equal(eventStatusKey('confirmed'), 'confirmed');
  assert.equal(eventStatusKey('no_show'), 'no_show');
  assert.equal(eventStatusKey('attended'), null);
});

test('разделитель «·» между ЛПР и номером ставится в конец предыдущего блока, а не в начало строки', () => {
  assert.equal(contactDot({ hasName: true, hasPhone: true }), 'after-name');
  assert.equal(contactDot({ hasName: false, hasPhone: true }), 'none');
  assert.equal(contactDot({ hasName: true, hasPhone: false }), 'none');
});
