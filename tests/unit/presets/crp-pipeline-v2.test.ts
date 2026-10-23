/* eslint-disable @typescript-eslint/no-explicit-any -- документы настроек в тестах читаются по путям, схема уже проверена */
// Пресет ЦРП, воронка v2 (docs/pipeline-v2-design.md §6.5, §8.2, §10, §15.1; D-337…D-342, D-348, D-349):
// значения накладки, ссылки между ними, неизменность того, что старая версия читает, и чистота нижних слоёв.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../helpers/sourceFiles';
import { assembleChain, LAYER_FILES, loadLayer, validChain } from '../config/helpers';

type Doc = Record<string, any>;

function crp(): { g: Doc; s: Doc } {
  const a = assembleChain(['base', 'kz', 'consulting-sales', 'crp']);
  return { g: a.global as Doc, s: a.spaces.sales as Doc };
}
const byKey = (xs: Doc[], key: string): Doc => {
  const x = xs.find((e) => e.key === key);
  assert.ok(x, `нет элемента «${key}»`);
  return x;
};
const keys = (xs: Doc[]) => xs.map((x) => x.key);

test('набор ЦРП проходит схему v1 и ссылочные проверки', () => {
  const r = validChain(['base', 'kz', 'consulting-sales', 'crp']);
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.issues));
});

test('причины перезвона: состав, системные признаки, manual:false только у повторной продажи и возврата', () => {
  const { s } = crp();
  const cb: Doc[] = s.reasons.callback;
  assert.deepEqual(keys(cb), ['think', 'not_now', 'no_time', 'no_show_br', 'no_show_bk', 'attended_no_buy', 'wont_come_br', 'repeat_sale', 'returned', 'other']);
  assert.deepEqual(cb.filter((r) => r.manual === false).map((r) => r.key), ['repeat_sale', 'returned']);
  assert.deepEqual(
    Object.fromEntries(cb.filter((r) => r.system).map((r) => [r.key, r.system])),
    { no_show_br: 'no_show', no_show_bk: 'no_show', attended_no_buy: 'attended_no_purchase', repeat_sale: 'client_return', returned: 'return_due' },
  );
  assert.deepEqual(byKey(cb, 'no_show_br').eventTypes, ['br']);
  assert.deepEqual(byKey(cb, 'no_show_bk').eventTypes, ['bk']);
  assert.equal(byKey(cb, 'other').needsText, true);
  assert.ok(cb.every((r) => r.softness === 'soft' && !r.archived));
});

test('ручное списание и проигрыш сделки: written_off и system write_off', () => {
  const { s } = crp();
  assert.deepEqual(keys(s.reasons.written_off), ['unreachable', 'other']);
  assert.ok(s.reasons.written_off.every((r: Doc) => r.softness === 'hard'));
  assert.equal(byKey(s.reasons.written_off, 'other').needsText, true);
  assert.equal(byKey(s.reasons.deal_lost, 'no_show_unreachable').system, 'write_off');
  assert.equal(s.reasons.deal_lost.filter((r: Doc) => r.system === 'write_off').length, 1);
});

test('подписи причин «Мусора» по требованию руководителя', () => {
  const { s } = crp();
  assert.deepEqual(byKey(s.reasons.not_interested, 'no_need').label, { ru: 'Не нужны услуги' });
  assert.deepEqual(byKey(s.reasons.not_target, 'company_closed').label, { ru: 'Закрыл компанию' });
});

test('итог «Перезвонить» не тронут: старая версия не требует причину (§4.1)', () => {
  const { s } = crp();
  const cb = byKey(s.calling.outcomes, 'callback');
  assert.equal(cb.reasonGroup, null);
  assert.equal(cb.requires.reason, false);
  assert.equal(cb.requires.callbackAt, true);
});

test('перезвон: причина обязательна, подсказка 3/7/14 дней, возврат клиента через 90 дней', () => {
  const { s } = crp();
  assert.deepEqual(s.calling.callbackReason, { required: true });
  assert.deepEqual(s.calling.callbackSchedule, { steps: ['+3d', '+7d', '+14d'] });
  assert.equal(s.calling.returnDays.client, 90);
  // прежние сроки возвратов не меняются
  const base = (loadLayer('base').spaceDefaults as Doc).calling.returnDays;
  assert.equal(s.calling.returnDays.not_interested, base.not_interested);
});

test('горячесть §6.5: порядок причин, признаки, состояния; ключи — живые причины перезвона', () => {
  const { s } = crp();
  assert.equal(s.queue.sort, 'heat');
  const h = s.queue.heat;
  assert.deepEqual(h.states, { callback: 100, new: 20, retry: 0 });
  assert.deepEqual(h.flags, { attendedGroup: 200, attendedIndividual: 300, noShow: 100, purchased: 250, lprYes: 50 });
  const order = Object.entries(h.reasons as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // ВП-10: пришёл, не купил › не пришёл на консультацию › не пришёл на БР › повторная продажа › подумает › нет времени › пока не нужно
  const pos = (k: string) => order.indexOf(k);
  for (const [hi, lo] of [['attended_no_buy', 'no_show_bk'], ['no_show_bk', 'no_show_br'], ['no_show_br', 'repeat_sale'], ['repeat_sale', 'think'], ['think', 'no_time'], ['no_time', 'not_now']]) {
    assert.ok(pos(hi!) < pos(lo!), `${hi} выше ${lo}`);
  }
  assert.equal(h.reasons.returned, h.reasons.no_time);
  const live = new Set(s.reasons.callback.filter((r: Doc) => !r.archived).map((r: Doc) => r.key));
  for (const k of Object.keys(h.reasons)) assert.ok(live.has(k), `вес у неизвестной причины «${k}»`);
  // пример §6.5: «не пришёл на БР» на сегодня = 100 + 400 + 100
  assert.equal(h.states.callback + h.reasons.no_show_br + h.flags.noShow, 600);
});

test('доска §8.2: шесть колонок, «Мусор» с быстрыми причинами, запасная колонка и тона', () => {
  const { s } = crp();
  const b = s.board;
  assert.deepEqual(
    b.columns.map((c: Doc) => [c.key, c.label.ru, c.states, c.eventTypes ?? null]),
    [
      ['new', 'Новые', ['new'], null],
      ['callback', 'Перезвон', ['retry', 'callback'], null],
      ['br', 'Бизнес-разбор', ['agreed'], ['br']],
      ['bk', 'Консультация', ['agreed'], ['bk']],
      ['purchase', 'Покупка', ['client'], null],
      ['trash', 'Мусор', ['not_interested', 'not_target', 'do_not_call', 'written_off'], null],
    ],
  );
  const trash = byKey(b.columns, 'trash');
  assert.equal(trash.recentDays, 30);
  assert.equal(trash.dropMore, true);
  assert.deepEqual(trash.drop, [
    { kind: 'not_target', reason: 'company_closed' },
    { kind: 'not_interested', reason: 'no_need' },
    { kind: 'written_off', reason: 'unreachable' },
  ]);
  assert.equal(b.agreedFallback, 'br');
  assert.deepEqual(b.tones, [{ when: 'attendedIndividual', tone: 'warning' }, { when: 'attendedGroup', tone: 'success' }]);
});

test('тема: тёмная в стиле сайта, по умолчанию — как в системе (ВП-12)', () => {
  const { g } = crp();
  assert.deepEqual(g.theme.dark, { canvas: '#0d1424', surface: '#141d31', accentColor: '#e8edf7' });
  assert.equal(g.theme.defaultMode, 'system');
});

test('«Целина» (ВП-1): тип услуги с вариантами онлайн и офлайн; цены синтетические и помечены', () => {
  const { s } = crp();
  const c = byKey(s.serviceTypes, 'celina');
  assert.deepEqual(c.label, { ru: 'Целина' });
  assert.deepEqual(keys(c.variants), ['online', 'offline']);
  for (const v of c.variants) assert.ok(Number.isInteger(v.amountKzt) && v.amountKzt > 0 && v.amountKzt % 10_000 === 0, `${v.key}: круглая синтетика`);
  // прочие услуги без вариантов: сумму вводит консультант
  assert.ok(s.serviceTypes.filter((t: Doc) => t.key !== 'celina').every((t: Doc) => t.variants === undefined));
  const pending = readFileSync(path.join(ROOT, 'presets', 'clients', 'crp', 'PENDING.md'), 'utf8');
  assert.match(pending, /уточнить у ЦРП/u);
  for (const v of c.variants) assert.ok(pending.includes(`celina.${v.key}`), `в PENDING.md нет строки celina.${v.key}`);
});

test('обзвон подтверждения явки (ВП-2): четверг, вид БР, причина «не придёт» — ручная', () => {
  const { s } = crp();
  assert.deepEqual(s.booking.confirmCall, { eventTypes: ['br'], weekdays: [4], declineReason: 'wont_come_br' });
  const r = byKey(s.reasons.callback, 'wont_come_br');
  assert.notEqual(r.manual, false);
  assert.equal(r.system, undefined);
});

test('явку оператор не отмечает до ответа на ВП-4: гранта booking.attend у operator нет', () => {
  const { g } = crp();
  const op = byKey(g.roles, 'operator');
  assert.ok(!op.grants.some((x: Doc) => x.perm === 'booking.attend'), JSON.stringify(op.grants));
});

test('нижние слои не задают ключей воронки v2: продукт без пресета клиента работает как раньше', () => {
  for (const k of ['base', 'kz', 'consulting-sales'] as const) {
    const text = readFileSync(path.join(ROOT, 'presets', LAYER_FILES[k]), 'utf8');
    for (const key of ['"callbackReason"', '"callbackSchedule"', '"board"', '"heat"', '"sort"', '"written_off"', '"callback": [', '"variants"', '"confirmCall"', '"dark"', '"defaultMode"']) {
      assert.ok(!text.includes(key), `${k}: ${key}`);
    }
  }
});
