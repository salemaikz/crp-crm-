// Роли для списка исполнителей (D-253): сотрудники с `task.read` охвата space/all (не «только чтение») и консультанты
// с окном `booked_with_me`; `tasks.askNextStep` и календарь из настроек пространства.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimalGlobal, minimalSpace } from '@crm/core/config/testing/minimal';
import { parseTasksConfig } from '../../../src/server/domain/tasks/settings';

const role = (key: string, extra: Record<string, unknown>) => ({ key, label: { ru: key }, readOnly: false, grants: [], relations: [], fieldAccessDefault: 'edit', menu: [], ...extra });

function config() {
  const g = minimalGlobal() as Record<string, unknown>;
  g.roles = [
    role('operator', { grants: [{ perm: 'task.read', scope: 'own' }, { perm: 'task.write', scope: 'own' }] }),
    role('rop', { grants: [{ perm: 'task.read', scope: 'space' }, { perm: 'task.write', scope: 'space' }, { perm: 'task.assign_others', scope: 'space' }] }),
    role('director', { readOnly: true, grants: [{ perm: 'task.read', scope: 'space' }] }),
    role('owner', { grants: [{ perm: 'task.read', scope: 'all' }] }),
    role('gone', { archived: true, grants: [{ perm: 'task.read', scope: 'space' }] }),
    role('consultant', {
      grants: [{ perm: 'task.read', scope: 'own' }],
      relations: [{ key: 'booked_with_me', params: { fromDays: -1, toDays: 30 }, actions: [] }, { key: 'duty_today', params: {}, actions: [] }],
    }),
  ];
  const s = minimalSpace() as Record<string, unknown>;
  s.tasks = { overdueAlertMinutes: 60, inboundReplyMinutes: 15, askNextStep: { consultant: true } };
  return { global: g, space: s };
}

test('исполнители: роли пространства без «только чтения» и архива; консультанты — с окном', () => {
  const cfg = parseTasksConfig(config());
  assert.deepEqual(cfg.staffRoles, ['rop', 'owner']);
  assert.deepEqual(cfg.consultantRoles, [{ key: 'consultant', window: { fromDays: -1, toDays: 30 } }]);
});

test('askNextStep по роли и рабочий календарь из настроек', () => {
  const cfg = parseTasksConfig(config());
  assert.equal(cfg.askNextStep.consultant, true);
  assert.equal(cfg.askNextStep.operator, undefined);
  assert.equal(cfg.calendar.isWorkingMoment(Date.UTC(2026, 9, 30, 10, 0)), true);
  assert.equal(cfg.calendar.isWorkingMoment(Date.UTC(2026, 9, 31, 10, 0)), false);
});

test('сломанный срез настроек — исключение, а не угаданные роли', () => {
  const c = config();
  (c.space as Record<string, unknown>).tasks = {};
  assert.throws(() => parseTasksConfig(c));
});
