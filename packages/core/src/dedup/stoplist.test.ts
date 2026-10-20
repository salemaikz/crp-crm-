import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStopList } from './stoplist';
import { evaluateRules } from './rules';

// Тестовый «HMAC»: префикс; настоящий ключ ядру неизвестен.
const hash = (v: string) => `h:${v}`;
const stop = new Set([hash('77091110001'), hash('77091110002')]);

test('стоп-лист: все рабочие номера в списке → stop_list, ничего не остаётся', () => {
  const r = applyStopList(['77091110001', '77091110002'], hash, stop);
  assert.deepEqual(r, { verdict: 'stop_list', allowed: [], stopped: ['77091110001', '77091110002'] });
});

test('стоп-лист: остался другой рабочий номер — идём дальше, стоп-номер отброшен (D-021)', () => {
  const r = applyStopList(['77091110001', '77093330003'], hash, stop);
  assert.deepEqual(r, { verdict: 'ok', allowed: ['77093330003'], stopped: ['77091110001'] });
});

test('стоп-лист: рабочих номеров не было — это «Без рабочего номера», не стоп-лист', () => {
  assert.equal(applyStopList([], hash, stop).verdict, 'no_working_phone');
});

test('стоп-лист: повтор номера не плодит дубли', () => {
  const r = applyStopList(['77093330003', '77093330003'], hash, stop);
  assert.deepEqual(r.allowed, ['77093330003']);
});

test('правила источника: legalFormIn и regionNotIn', () => {
  const rules = [
    { code: 'legal_review', type: 'legalFormIn' as const, values: ['ИП'] },
    { code: 'region', type: 'regionNotIn' as const, values: ['Город-А'] },
  ];
  assert.equal(evaluateRules(rules, { legalForm: 'ип', region: 'г.Город-А' })?.code, 'legal_review');
  assert.equal(evaluateRules(rules, { legalForm: 'тоо', region: 'г.Город-Б, район "Север"' })?.code, 'region');
  assert.equal(evaluateRules(rules, { legalForm: 'тоо', region: 'г. город-а, район "Север"' }), null);
  assert.equal(evaluateRules(rules, { legalForm: 'тоо', region: '' }), null, 'неизвестный регион правило не срабатывает');
  assert.equal(evaluateRules([], { legalForm: 'ип', region: 'x' }), null);
});
