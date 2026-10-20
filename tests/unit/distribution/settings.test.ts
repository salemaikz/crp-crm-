// Разбор настроек раздачи: пресет base, накладка ЦРП, календарь, ошибки схемы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DistributionDomainError } from '../../../src/server/domain/distribution/errors';
import { parseDistributionConfig } from '../../../src/server/domain/distribution/settings';
import { assembleChain } from '../config/helpers';

const SPACE = 'sp-test';

function cfgOf(chain: Parameters<typeof assembleChain>[0]) {
  const a = assembleChain(chain);
  return parseDistributionConfig({ spaceId: SPACE, global: a.global, space: a.spaces.sales });
}

test('base: режим manual, лимит 40, состав лимита, мобильные раньше', () => {
  const c = cfgOf(['base']);
  assert.equal(c.spaceId, SPACE);
  assert.equal(c.settings.mode, 'manual');
  assert.equal(c.settings.dailyCap, 40);
  assert.deepEqual(c.settings.capIncludes, ['auto', 'manual', 'return']);
  assert.equal(c.settings.capOverride, false);
  assert.deepEqual(c.settings.schedule, { from: '08:00', to: '18:00', everyMin: 60, workdaysOnly: true });
  assert.deepEqual(c.participantRoles, ['manager']);
  assert.equal(c.mobileFirst, true);
});

test('накладка ЦРП: автораздача поровну, участники — роль operator, пояс Алматы', () => {
  const c = cfgOf(['base', 'kz', 'consulting-sales', 'crp']);
  assert.equal(c.settings.mode, 'auto_even');
  assert.deepEqual(c.participantRoles, ['operator']);
  assert.equal(c.timeZone, 'Asia/Almaty');
});

test('календарь в форме ядра раздачи: сутки, минуты от полуночи, рабочие дни', () => {
  const c = cfgOf(['base', 'kz']);
  const at = Date.UTC(2026, 9, 28, 6, 0); // 11:00 по Алматы
  assert.equal(c.calendar.localDay(at), '2026-10-28');
  assert.equal(c.calendar.localMinutes(at), 11 * 60);
  assert.equal(c.calendar.isWorkday('2026-10-28'), true);
  assert.equal(c.calendar.isWorkday('2026-10-31'), false, 'суббота');
  assert.equal(c.calendar.nextWorkday('2026-10-30'), '2026-11-02', 'после пятницы — понедельник');
});

test('сломанный документ → invalid_settings', () => {
  const a = assembleChain(['base']);
  const sales = a.spaces.sales as Record<string, unknown>;
  for (const bad of [{ ...sales, distribution: { mode: 'chaos' } }, { ...sales, queue: {} }, { ...sales, distribution: undefined }]) {
    assert.throws(
      () => parseDistributionConfig({ spaceId: SPACE, global: a.global, space: bad }),
      (e) => e instanceof DistributionDomainError && e.code === 'invalid_settings',
    );
  }
  assert.throws(() => parseDistributionConfig({ spaceId: SPACE, global: {}, space: sales }), DistributionDomainError);
  assert.throws(() => parseDistributionConfig({ spaceId: SPACE, global: a.global, space: null }), DistributionDomainError);
});
