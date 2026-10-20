// Настройки уведомлений: роли получателей из пресета ЦРП, пороги, расписания задач digest и alarms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alarmsJob, alarmsSchedule, digestJob, digestSchedule } from '../../../src/server/domain/notify/job';
import { morningDigestAt, parseNotifyConfig } from '../../../src/server/domain/notify/settings';
import { assembleChain } from '../config/helpers';

function cfgOf(chain: Parameters<typeof assembleChain>[0]) {
  const a = assembleChain(chain);
  return { a, cfg: parseNotifyConfig({ spaceId: 'sp-test', global: a.global, space: a.spaces.sales }) };
}

test('пресет ЦРП: РОП — получатель тревог, оператор — получатель сводки; архивные роли base не участвуют', () => {
  const { cfg } = cfgOf(['base', 'kz', 'consulting-sales', 'crp']);
  assert.deepEqual(cfg.managerRoles, ['rop']);
  assert.deepEqual(cfg.operatorRoles, ['operator']);
  assert.equal(cfg.morningDigestAt, '09:00');
  assert.equal(cfg.overdueAlertMinutes, 60);
  assert.equal(cfg.spaceId, 'sp-test');
});

test('сломанный документ — исключение, а не угаданные роли', () => {
  assert.throws(() => parseNotifyConfig({ spaceId: 's', global: {}, space: {} }));
});

test('digest: ежедневно в morningDigestAt по рабочим дням; null и сломанный документ — задачи нет', () => {
  const { a } = cfgOf(['base', 'kz']);
  assert.deepEqual(digestSchedule({ global: a.global, space: a.spaces.sales }), { kind: 'daily', at: '09:00', days: 'workdays' });
  const off = { notifications: { morningDigestAt: null }, tasks: { overdueAlertMinutes: 60 } };
  assert.equal(digestSchedule({ global: {}, space: off }), null);
  assert.equal(digestSchedule({ global: {}, space: null }), null);
  assert.equal(morningDigestAt({ notifications: { morningDigestAt: '25:99' } }), null);
  assert.deepEqual(digestSchedule({ global: {}, space: { notifications: { morningDigestAt: '08:30' } } }), { kind: 'daily', at: '08:30', days: 'workdays' });
});

test('alarms: сетка 09:00–18:00 раз в час по рабочим дням, догон 15 минут', () => {
  assert.deepEqual(alarmsSchedule(), { kind: 'grid', from: '09:00', to: '18:00', everyMin: 60, days: 'workdays', graceMin: 15 });
});

test('определения задач: по пространству, пишут бизнес-данные', () => {
  for (const [def, name] of [[digestJob, 'digest'], [alarmsJob, 'alarms']] as const) {
    assert.equal(def.name, name);
    assert.equal(def.perSpace, true);
    assert.equal(def.writes, 'business');
  }
});
