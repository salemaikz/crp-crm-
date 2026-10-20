// Пригодность плагина (D-268): матрица PluginGate × плагины, порядок причин.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginGate } from '../../../src/integrations/contract';
import { pluginUsability } from '../../../src/integrations/enablement';
import { beelineTelephony } from '../../../src/integrations/telephony/beeline';
import { manualTelephony } from '../../../src/integrations/telephony/manual';
import { waLinkMessenger } from '../../../src/integrations/messenger/wa-link';

const ALL_OFF: PluginGate = { flagOn: false, licensed: false, enabled: false, crossBorderApproved: false };
const ALL_ON: PluginGate = { flagOn: true, licensed: true, enabled: true, crossBorderApproved: true };
const crossBorder = { flag: 'WAZZUP' as const, licenseFeature: 'messenger.wazzup', crossBorder: true, needsConnection: true };

test('manual и wa_link пригодны всегда: без флага, лицензии и подключения', () => {
  for (const p of [manualTelephony, waLinkMessenger]) {
    assert.deepEqual(pluginUsability(p, ALL_OFF), { usable: true }, p.id);
  }
});

test('beeline: флаг → лицензия → подключение; решение о передаче за рубеж не нужно (данные в РК)', () => {
  assert.deepEqual(pluginUsability(beelineTelephony, ALL_OFF), { usable: false, reason: 'flag_off' });
  assert.deepEqual(pluginUsability(beelineTelephony, { ...ALL_OFF, flagOn: true }), { usable: false, reason: 'not_licensed' });
  assert.deepEqual(pluginUsability(beelineTelephony, { ...ALL_OFF, flagOn: true, licensed: true }), { usable: false, reason: 'disabled' });
  assert.deepEqual(pluginUsability(beelineTelephony, { ...ALL_ON, crossBorderApproved: false }), { usable: true });
});

test('зарубежный плагин: без отметки решения непригоден даже включённым', () => {
  assert.deepEqual(pluginUsability(crossBorder, { ...ALL_ON, crossBorderApproved: false }), { usable: false, reason: 'crossborder_not_approved' });
  assert.deepEqual(pluginUsability(crossBorder, ALL_ON), { usable: true });
  // первая причина побеждает: выключенный флаг важнее отсутствия лицензии
  assert.deepEqual(pluginUsability(crossBorder, { ...ALL_OFF, licensed: false }), { usable: false, reason: 'flag_off' });
  // все 16 сочетаний: пригоден только при всех четырёх условиях
  for (let m = 0; m < 16; m++) {
    const gate: PluginGate = { flagOn: !!(m & 1), licensed: !!(m & 2), enabled: !!(m & 4), crossBorderApproved: !!(m & 8) };
    assert.equal(pluginUsability(crossBorder, gate).usable, m === 15, JSON.stringify(gate));
  }
});
