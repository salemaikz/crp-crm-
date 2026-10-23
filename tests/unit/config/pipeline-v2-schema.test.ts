/* eslint-disable @typescript-eslint/no-explicit-any -- документы настроек в тестах правятся по путям */
// Ключи настроек воронки v2 в схеме v1 (docs/pipeline-v2-design.md §8.1, D-346): принимаются, отвергаются,
// ссылочные проверки набора; пресеты без новых ключей разбираются как раньше.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigSet } from '@crm/core/config';
import { minimalSet } from '../../../packages/core/src/config/testing/minimal';
import { validChain } from './helpers';

const t = (ru: string) => ({ ru });
const evt = (key: string) => ({ key, behavior: 'group', label: t(key), short: t(key), capacity: 10, durationMin: 60, directions: [] });
const reason = (key: string, extra: object = {}) => ({ key, label: t(key), needsText: false, softness: 'soft', ...extra });

/** Набор с видами br/bk и группами причин; `edit` правит документ пространства. */
function check(edit: (sp: any, g: any) => void = () => {}) {
  const set: any = minimalSet();
  const sp = set.spaces.sales;
  sp.booking.eventTypes = [evt('br'), evt('bk')];
  sp.reasons.callback = [reason('think'), reason('other', { needsText: true })];
  sp.reasons.deal_lost = [reason('lost')];
  edit(sp, set.global);
  const r = validateConfigSet(set);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}
const ok = (edit: (sp: any, g: any) => void) => assert.deepEqual(check(edit), []);
const bad = (edit: (sp: any, g: any) => void, needle: string) => {
  const iss = check(edit);
  assert.ok(iss.some((i) => i.includes(needle)), `ждали «${needle}», получили ${JSON.stringify(iss)}`);
};

test('набор без новых ключей проходит', () => assert.deepEqual(check(), []));

test('пресеты base и клиента разбираются без новых ключей', () => {
  for (const chain of [['base'], ['base', 'kz', 'consulting-sales', 'crp']] as const) {
    const r: any = validChain([...chain]);
    assert.ok(r.ok, JSON.stringify(r.issues));
  }
});

test('Reason: system, eventTypes, manual', () => {
  ok((sp) => { sp.reasons.callback.push(reason('ns', { system: 'no_show', eventTypes: ['br'], manual: false })); });
  bad((sp) => { sp.reasons.callback.push(reason('x', { system: 'unknown' })); }, 'system');
  bad((sp) => { sp.reasons.callback.push(reason('x', { manual: 'no' })); }, 'manual');
  bad((sp) => { sp.reasons.callback.push(reason('x', { eventTypes: ['nope'] })); }, 'типа мероприятия «nope»');
  bad((sp) => { sp.reasons.callback.push(reason('x', { extra: 1 })); }, 'extra');
});

test('system write_off только в deal_lost; written_off требует списание в deal_lost', () => {
  ok((sp) => { sp.reasons.deal_lost = [reason('wo', { system: 'write_off' })]; sp.reasons.written_off = [reason('unreachable')]; });
  ok((sp) => { sp.reasons.deal_lost = [reason('other')]; sp.reasons.written_off = [reason('unreachable')]; });
  bad((sp) => { sp.reasons.callback.push(reason('x', { system: 'write_off' })); }, 'только в группе deal_lost');
  bad((sp) => { sp.reasons.written_off = [reason('unreachable')]; }, 'нужна причина с system');
});

test('calling.callbackReason, callbackSchedule, returnDays.client', () => {
  ok((sp) => { sp.calling.callbackReason = { required: true }; });
  bad((sp) => { sp.calling.callbackReason = { required: 1 }; }, 'callbackReason');
  bad((sp) => { sp.calling.callbackReason = { required: true, x: 1 }; }, 'x');
  for (const steps of [['+3d'], ['+3d@10:00', '+365d'], Array.from({ length: 10 }, () => '+1d')]) {
    ok((sp) => { sp.calling.callbackSchedule = { steps }; });
  }
  for (const s of ['+0d', '+400d', '+366d', '+3d@25:00', '3d', '+2h', '+3d@9:00']) {
    bad((sp) => { sp.calling.callbackSchedule = { steps: [s] }; }, 'callbackSchedule');
  }
  bad((sp) => { sp.calling.callbackSchedule = { steps: [] }; }, 'callbackSchedule');
  bad((sp) => { sp.calling.callbackSchedule = { steps: Array.from({ length: 11 }, () => '+1d') }; }, 'callbackSchedule');
  ok((sp) => { sp.calling.returnDays.client = 90; });
  ok((sp) => { sp.calling.returnDays.client = null; });
  bad((sp) => { sp.calling.returnDays.client = 0; }, 'client');
  bad((sp) => { sp.calling.returnDays.client = 3651; }, 'client');
});

test('callbackReason.required требует живую ручную причину перезвона', () => {
  bad((sp) => { sp.calling.callbackReason = { required: true }; delete sp.reasons.callback; }, 'нужна живая ручная причина');
  bad((sp) => { sp.calling.callbackReason = { required: true }; sp.reasons.callback = [reason('a', { archived: true }), reason('b', { manual: false })]; }, 'нужна живая ручная причина');
  ok((sp) => { sp.calling.callbackReason = { required: false }; delete sp.reasons.callback; });
});

test('queue.sort и queue.heat', () => {
  const heat = (over: any = {}) => ({
    states: { callback: 100, new: 20 },
    reasons: { think: 5 },
    flags: { attendedGroup: 1, attendedIndividual: 2, noShow: 3, purchased: 4, lprYes: 5 },
    ...over,
  });
  ok((sp) => { sp.queue.sort = 'heat'; sp.queue.heat = heat(); });
  ok((sp) => { sp.queue.sort = 'groups'; });
  bad((sp) => { sp.queue.sort = 'random'; }, 'queue.sort');
  bad((sp) => { sp.queue.heat = heat({ states: { callback: 10001 } }); }, 'callback');
  bad((sp) => { sp.queue.heat = heat({ states: { callback: -1 } }); }, 'callback');
  bad((sp) => { sp.queue.heat = heat({ states: { nonsense: 1 } }); }, 'states');
  bad((sp) => { sp.queue.heat = heat({ flags: { attendedGroup: 1, attendedIndividual: 2, noShow: 3, purchased: 4, lprYes: 10001 } }); }, 'lprYes');
  bad((sp) => { sp.queue.heat = heat({ flags: { attendedGroup: 1 } }); }, 'flags');
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`reason_${i}`, 1]));
  ok((sp) => { sp.queue.heat = heat({ reasons: many(50) }); });
  bad((sp) => { sp.queue.heat = heat({ reasons: many(51) }); }, 'не больше 50');
  bad((sp) => { sp.queue.heat = heat({ extra: 1 }); }, 'extra');
});

const col = (key: string, states: string[], extra: object = {}) => ({ key, label: t(key), states, ...extra });

test('board: колонки, тона, ссылки', () => {
  const columns = [
    col('new', ['new']),
    col('br', ['agreed'], { eventTypes: ['br'] }),
    col('bk', ['agreed'], { eventTypes: ['bk'] }),
    col('trash', ['not_interested', 'written_off'], { recentDays: 30, drop: [{ kind: 'deal_lost', reason: 'lost' }], dropMore: true }),
  ];
  ok((sp) => { sp.board = { columns, agreedFallback: 'br', tones: [{ when: 'attendedGroup', tone: 'success' }] }; });
  bad((sp) => { sp.board = { columns, tones: [{ when: 'attendedGroup', tone: 'purple' }] }; }, 'tone');
  bad((sp) => { sp.board = { columns, tones: [{ when: 'other', tone: 'info' }] }; }, 'when');
  bad((sp) => { sp.board = { columns, extra: 1 }; }, 'extra');
  bad((sp) => { sp.board = { columns: [col('x', ['bogus'])] }; }, 'states');
  bad((sp) => { sp.board = { columns: [col('x', ['agreed'], { eventTypes: ['nope'] })] }; }, 'типа мероприятия «nope»');
  bad((sp) => { sp.board = { columns: [col('x', ['new'], { eventTypes: ['br'] })] }; }, 'только у колонки с состоянием agreed');
  bad((sp) => { sp.board = { columns: [col('x', ['new'], { drop: [{ kind: 'deal_lost', reason: 'ghost' }] })] }; }, 'нет причины «ghost»');
  bad((sp) => { sp.board = { columns: [col('x', ['new'], { drop: [{ kind: 'no_such', reason: 'lost' }] })] }; }, 'нет группы причин');
  bad((sp) => { sp.board = { columns: [col('a', ['new']), col('b', ['new', 'retry'])] }; }, 'в нескольких колонках');
  bad((sp) => { sp.board = { columns: [col('a', ['agreed'], { eventTypes: ['br'] }), col('b', ['agreed'])] }; }, 'в нескольких колонках');
  bad((sp) => { sp.board = { columns: columns.filter((c) => c.key !== 'trash') }; }, 'нужен agreedFallback');
  ok((sp) => { sp.board = { columns: [col('new', ['new']), col('br', ['agreed'], { eventTypes: ['br'] })] }; });
  bad((sp) => { sp.board = { columns, agreedFallback: 'ghost' }; }, 'нет колонки «ghost»');
  bad((sp) => { sp.board = { columns, agreedFallback: 'new' }; }, 'должна содержать состояние agreed');
  bad((sp) => { sp.board = { columns: [col('a', ['new']), col('a', ['retry'])] }; }, 'повтор ключа');
});

test('theme.defaultMode и theme.dark', () => {
  ok((_, g) => { g.theme.defaultMode = 'system'; g.theme.dark = { canvas: '#101010', surface: '#202020' }; });
  ok((_, g) => { g.theme.dark = {}; });
  bad((_, g) => { g.theme.defaultMode = 'auto'; }, 'defaultMode');
  bad((_, g) => { g.theme.dark = { canvas: 'red' }; }, 'canvas');
  bad((_, g) => { g.theme.dark = { foo: '#101010' }; }, 'foo');
});
