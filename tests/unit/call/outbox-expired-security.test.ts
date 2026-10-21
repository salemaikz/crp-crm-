// Удаление чужих итогов с общего телефона по сроку — мутация безопасности (D-054, D-308): ключ в закрытом списке ядра,
// маршрут помечен им, манифест изоляции знает об этом (прогон проверит, что лицензия «только чтение» не даёт 423).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { access } from '@crm/core';
import { ROOT } from '../../helpers/sourceFiles';
import manifest from '../../isolation/manifest/device';

test('ключ device.outbox_expire — в закрытом списке мутаций безопасности ядра', () => {
  assert.ok((access.SECURITY_MUTATIONS as readonly string[]).includes('device.outbox_expire'));
});

test('POST /api/device/outbox-expired помечен securityMutation device.outbox_expire, манифест — securityMutation: true', () => {
  const src = readFileSync(join(ROOT, 'src/app/api/device/outbox-expired/route.ts'), 'utf8');
  assert.match(src, /securityMutation: 'device\.outbox_expire'/);
  const entry = manifest.entries.find((e) => e.path === '/api/device/outbox-expired');
  assert.equal(entry?.securityMutation, true);
});
