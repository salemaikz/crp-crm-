// Регистрация тестов прогона изоляции: по тесту на запись манифеста (tests/isolation/manifest/*.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, type Runner } from './runner';

export async function defineIsolationRun(): Promise<void> {
  let runner: Runner | undefined;
  // Записи читаются заранее: тесты регистрируются по ним, БД открывается в before
  const { allEntries } = await import('../harness/load');
  const entries = await allEntries();

  describe('изоляция: манифест → прогон', () => {
    before(async () => {
      runner = await createRunner();
    });
    after(async () => {
      await runner?.close();
    });

    test('манифест не пуст и каждая запись находит код', () => {
      assert.ok(entries.length > 0);
      assert.ok(runner);
      const missing = runner.entries.filter((e) => !runner?.unitOf(e)).map((e) => `${e.module}: ${e.method} ${e.path}`);
      assert.deepEqual(missing, []);
    });

    for (const [i, entry] of entries.entries()) {
      test(`${entry.module}: ${entry.kind} ${entry.method} ${entry.path}`, async () => {
        assert.ok(runner);
        const e = runner.entries[i];
        assert.ok(e);
        assert.deepEqual(await runner.check(e), []);
      });
    }
  });
}
