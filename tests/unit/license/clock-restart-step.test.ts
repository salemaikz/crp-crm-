// Шаг пересчёта без опоры процесса (D-306) не меньше срока кэша состояния: снимок пересчёта после перезапуска
// обслуживает запросы не дольше шага, поэтому перезапуски перед каждым пересчётом не останавливают время лицензии.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { license as core } from '@crm/core';
import { LICENSE_CACHE_TTL_MS } from '../../../src/server/platform/license/current';

test('CLOCK_RESTART_STEP_MS не меньше срока кэша состояния лицензии процесса', () => {
  assert.ok(core.CLOCK_RESTART_STEP_MS >= LICENSE_CACHE_TTL_MS, `${core.CLOCK_RESTART_STEP_MS} < ${LICENSE_CACHE_TTL_MS}`);
});
