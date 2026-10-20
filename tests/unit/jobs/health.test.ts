import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAlive } from '../../../scripts/worker/index';
import { queueRetryDelayMs } from '../../../src/server/platform/jobs/queues';
import { retryDelayMs } from '../../../src/server/platform/jobs/repo';

test('healthcheck: свежий файл живости — жив, старый или отсутствующий — нет', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crm-alive-'));
  const f = path.join(dir, 'alive');
  assert.equal(isAlive(f), false);
  writeFileSync(f, '1');
  assert.equal(isAlive(f), true);
  const old = new Date(Date.now() - 120_000);
  utimesSync(f, old, old);
  assert.equal(isAlive(f), false);
});

test('паузы повторов: задачи 60 с, 120 с; очереди 30 с … не больше часа', () => {
  assert.deepEqual([1, 2, 3].map(retryDelayMs), [60_000, 120_000, 240_000]);
  assert.equal(queueRetryDelayMs(1), 30_000);
  assert.equal(queueRetryDelayMs(3), 120_000);
  assert.equal(queueRetryDelayMs(20), 3_600_000);
});
