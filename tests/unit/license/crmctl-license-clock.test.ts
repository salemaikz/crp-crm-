// crmctl license-clock (D-314): сброс правила часов — откат времени лицензии, поэтому без --yes не начинается и БД
// не открывает. Сам сброс (эпизод, аудит license.clock_reset) — tests/integration/license/license.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLicenseClock } from '../../../scripts/crmctl/license-clock';

async function quiet<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const out: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  try {
    return [await fn(), out.join('\n')];
  } finally {
    console.error = orig;
  }
}

test('license-clock: без подкоманды — справка и код 2', async () => {
  const [code, err] = await quiet(() => runLicenseClock([]));
  assert.equal(code, 2);
  assert.match(err, /license-clock reset --yes/);
});

test('license-clock reset без --yes — отказ с объяснением, до открытия БД', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const [code, err] = await quiet(() => runLicenseClock(['reset']));
    assert.equal(code, 2);
    assert.match(err, /--yes/);
    assert.match(err, /license\.clock_reset/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});
