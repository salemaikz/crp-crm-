// Эффективные настройки обзвона под флагами (pipeline-v2 §8.3): флаг решает, что сервер принимает и показывает;
// записанные данные (справочник причин) читаются всегда.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCallingSettings } from '../../../src/server/domain/cards/settings';

const doc = {
  calling: { callbackReason: { required: true }, callbackSchedule: { steps: ['+3d', '+7d@10:00'] } },
  queue: { sort: 'heat' },
  reasons: {
    callback: [
      { key: 'think', label: { ru: 'Подумает' }, needsText: false, softness: 'soft' },
      { key: 'old', label: { ru: 'Старая' }, needsText: false, softness: 'soft', archived: true },
      { key: 'ret', label: { ru: 'Возврат' }, needsText: false, softness: 'soft', system: 'client_return', manual: false },
      { key: 'noshow', label: { ru: 'Неявка' }, needsText: false, softness: 'soft', system: 'no_show', eventTypes: ['br'] },
    ],
    deal_lost: [{ key: 'unreach', label: { ru: 'Не отвечает' }, needsText: false, softness: 'hard', system: 'write_off' }],
  },
};

test('оба флага включены: причины, шаги и сортировка действуют', () => {
  const e = effectiveCallingSettings(doc, { CALLBACK_V2: true, OP_BOARD: true });
  assert.equal(e.callbackV2, true);
  assert.deepEqual(e.callbackReason, { required: true });
  assert.deepEqual(e.callbackSchedule, { steps: ['+3d', '+7d@10:00'] });
  assert.equal(e.queueSort, 'heat');
});

test('CALLBACK_V2 выключен: callbackReason и callbackSchedule не действуют, справочник читается', () => {
  const e = effectiveCallingSettings(doc, { CALLBACK_V2: false, OP_BOARD: true });
  assert.equal(e.callbackV2, false);
  assert.equal(e.callbackReason, undefined);
  assert.equal(e.callbackSchedule, undefined);
  assert.equal(e.reasons?.callback?.length, 4, 'записанные причины читаются при любом флаге');
});

test('OP_BOARD выключен: сортировка groups', () => {
  assert.equal(effectiveCallingSettings(doc, { CALLBACK_V2: true, OP_BOARD: false }).queueSort, 'groups');
});

test('нет ключей: прежнее поведение, справочника нет', () => {
  const e = effectiveCallingSettings({}, { CALLBACK_V2: true, OP_BOARD: true });
  assert.equal(e.callbackReason, undefined);
  assert.equal(e.callbackSchedule, undefined);
  assert.equal(e.reasons, undefined);
  assert.equal(e.queueSort, 'groups');
});

test('справочник причин для ядра: manual по умолчанию истина, system и eventTypes переносятся', () => {
  const r = effectiveCallingSettings(doc, { CALLBACK_V2: true, OP_BOARD: false }).reasons!;
  assert.deepEqual(r.callback, [
    { code: 'think', archived: false, manual: true },
    { code: 'old', archived: true, manual: true },
    { code: 'ret', archived: false, manual: false, system: 'client_return' },
    { code: 'noshow', archived: false, manual: true, system: 'no_show', eventTypes: ['br'] },
  ]);
  assert.deepEqual(r.deal_lost, [{ code: 'unreach', archived: false, manual: true, system: 'write_off' }]);
});
