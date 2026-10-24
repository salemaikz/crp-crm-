/* eslint-disable @typescript-eslint/no-explicit-any -- документы настроек в тестах правятся по путям */
// Ключи по ответам владельца 23.10 (docs/pipeline-v2-design.md §15.1, D-348, D-349): варианты услуги с ценой
// и обзвон подтверждения явки. Входят в схему v1 до заморозки 0.9.0 (D-346): нет ключа — прежнее поведение.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigSet } from '@crm/core/config';
import { minimalSet } from '../../../packages/core/src/config/testing/minimal';

const t = (ru: string) => ({ ru });
const evt = (key: string) => ({ key, behavior: 'group', label: t(key), short: t(key), capacity: 10, durationMin: 60, directions: [] });
const reason = (key: string, extra: object = {}) => ({ key, label: t(key), needsText: false, softness: 'soft', ...extra });
const service = (key: string, extra: object = {}) => ({ key, label: t(key), routeToTeam: null, ...extra });
const variant = (key: string, amountKzt: unknown, extra: object = {}) => ({ key, label: t(key), amountKzt, ...extra });

function check(edit: (sp: any) => void = () => {}) {
  const set: any = minimalSet();
  const sp = set.spaces.sales;
  sp.booking.eventTypes = [evt('ev')];
  sp.reasons.callback = [reason('think'), reason('wont_come', { eventTypes: ['ev'] }), reason('auto', { system: 'client_return', manual: false })];
  sp.serviceTypes = [service('svc')];
  edit(sp);
  const r = validateConfigSet(set);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}
const ok = (edit: (sp: any) => void) => assert.deepEqual(check(edit), []);
const bad = (edit: (sp: any) => void, needle: string) => {
  const iss = check(edit);
  assert.ok(iss.some((i) => i.includes(needle)), `ждали «${needle}», получили ${JSON.stringify(iss)}`);
};

test('без новых ключей набор проходит', () => assert.deepEqual(check(), []));

test('serviceTypes[].variants: ключ, подпись, цена в целых тенге', () => {
  ok((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('online', 100000), variant('offline', 200000)] })]; });
  ok((sp) => { sp.serviceTypes = [service('svc', { variants: [] })]; });
  ok((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('old', 1, { archived: true })] })]; });
  ok((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('max', 1_000_000_000_000)] })]; });
  bad((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('a', 0)] })]; }, 'amountKzt');
  bad((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('a', 99.5)] })]; }, 'amountKzt');
  bad((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('a', '100')] })]; }, 'amountKzt');
  bad((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('a', 1_000_000_000_001)] })]; }, 'amountKzt');
  bad((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('a', 1), variant('a', 2)] })]; }, 'повтор ключа');
  bad((sp) => { sp.serviceTypes = [service('svc', { variants: [variant('a', 1, { note: 'x' })] })]; }, 'note');
});

test('booking.confirmCall: виды мероприятий, дни недели, причина отказа из reasons.callback', () => {
  const cc = (extra: object = {}) => ({ eventTypes: ['ev'], weekdays: [4], declineReason: 'wont_come', ...extra });
  ok((sp) => { sp.booking.confirmCall = cc(); });
  ok((sp) => { sp.booking.confirmCall = cc({ weekdays: [1, 4] }); });
  bad((sp) => { sp.booking.confirmCall = cc({ weekdays: [] }); }, 'weekdays');
  bad((sp) => { sp.booking.confirmCall = cc({ weekdays: [8] }); }, 'weekdays');
  bad((sp) => { sp.booking.confirmCall = cc({ eventTypes: [] }); }, 'eventTypes');
  bad((sp) => { sp.booking.confirmCall = cc({ extra: 1 }); }, 'extra');
  bad((sp) => { sp.booking.confirmCall = cc({ eventTypes: ['nope'] }); }, 'типа мероприятия «nope»');
  // консультация (individual) в конфиге принимается (D-349): доска пропускает её с invalid-setting, чтение настроек не падает
  ok((sp) => { sp.booking.eventTypes.push({ ...evt('solo'), behavior: 'individual', capacity: null }); sp.booking.confirmCall = cc({ eventTypes: ['ev', 'solo'] }); });
  bad((sp) => { sp.booking.confirmCall = cc({ declineReason: 'nope' }); }, 'нет причины «nope» в группе «callback»');
  bad((sp) => { sp.booking.confirmCall = cc({ declineReason: 'auto' }); }, 'ручной');
  bad((sp) => { sp.reasons.callback[1].archived = true; sp.booking.confirmCall = cc(); }, 'архив');
  bad((sp) => { delete sp.reasons.callback; sp.booking.confirmCall = cc({ declineReason: 'think' }); }, 'нет группы причин «callback»');
});
