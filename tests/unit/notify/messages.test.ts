// Каждый вид уведомления имеет текст в локали, а ICU-аргументы текста — ровно числа из params (ПДн в тексте нет).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFY_KINDS, type NotifyParams } from '../../../src/server/domain/notify/types';
import { icuArgs } from '../i18n-parity.test';

const msgs = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'messages', 'ru', 'notify.json'), 'utf8')) as {
  kinds: Record<string, string>;
};

// Ключи params по видам: компилятор следит, что список совпадает с NotifyParams
const PARAM_KEYS: { [K in keyof NotifyParams]: (keyof NotifyParams[K])[] } = {
  digest_operator: ['callbacks', 'bookings'],
  digest_manager: ['overdue', 'pool'],
  alarm_callbacks_overdue: ['count', 'operators'],
  alarm_handoff_unaccepted: ['count'],
  alarm_grey_unassigned: ['count'],
};

test('для каждого вида есть текст, аргументы совпадают с params', () => {
  for (const kind of NOTIFY_KINDS) {
    const text = msgs.kinds[kind];
    assert.ok(text, `нет текста ${kind}`);
    assert.deepEqual(icuArgs(text), [...PARAM_KEYS[kind]].map(String).sort(), kind);
  }
  assert.ok(msgs.kinds.unknown, 'нет текста для неизвестного вида');
});

test('сброс часов лицензии (D-314): аргументы текста — ровно числа из params, текст собирается', async () => {
  const text = msgs.kinds['license_clock_reset'];
  assert.ok(text);
  assert.deepEqual(icuArgs(text), ['rewindHours', 'wasLocked']);
  const { createTranslator } = await import('next-intl');
  const t = createTranslator({ locale: 'ru', messages: { kinds: msgs.kinds }, namespace: 'kinds' });
  assert.match(t('license_clock_reset', { rewindHours: 52, wasLocked: 1 }), /52 ч, режим «только чтение» снят\./);
  assert.match(t('license_clock_reset', { rewindHours: 3, wasLocked: 0 }), /3 ч\. Подробности/);
});
