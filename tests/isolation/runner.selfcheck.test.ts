// Самопроверка обвязки изоляции: на заведомо хороших маршрутах прогон зелёный, на заведомо плохих —
// красный с понятной причиной (утечка в ответе и HTML, различимый 404, запись в чужую строку,
// гости общего мероприятия без охвата записи).
// Хорошие и плохие маршруты лежат в tests/isolation/fixtures/ и в боевой манифест не входят.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import type { Runner } from './runner/runner';

// Хуки — до загрузки src/** (runner тянет src): поэтому runner грузится динамически
register('./runner/hooks.mjs', import.meta.url);
const { createRunner } = await import('./runner/runner');

const FIX = join(import.meta.dirname, 'fixtures');
const SRC = 'tests/isolation/fixtures/src';

let good: Runner;
let bad: Runner | undefined;
before(async () => {
  good = await createRunner({ manifestDir: join(FIX, 'manifest-good'), srcDir: SRC });
});
after(async () => {
  await good.close();
  await bad?.close();
});

test('хорошие маршруты, страница и действие проходят прогон', async () => {
  assert.equal(good.entries.length, 6);
  for (const e of good.entries) assert.deepEqual(await good.check(e), [], `${e.kind} ${e.method} ${e.path}`);
});

test('заведомо плохие маршруты и страница ловятся с причиной', async () => {
  await good.close();
  const runner = await createRunner({ manifestDir: join(FIX, 'manifest-bad'), srcDir: SRC });
  bad = runner;
  const byPath = async (path: string) => {
    const e = runner.entries.find((x) => x.path === path);
    assert.ok(e, path);
    return (await runner.check(e)).join('\n');
  };
  const leaky = await byPath('/api/leaky/[id]');
  assert.match(leaky, /ждали 404, получили 200/);
  assert.match(leaky, /найдены данные объекта оператора B/);
  assert.match(await byPath('/api/oracle/[id]'), /ждали 404, получили 403/);
  const write = await byPath('/api/leaky-write/[id]');
  assert.match(write, /таблица cards изменилась/);
  // Общий объект (D-161): мероприятие видно, но гости без охвата выдают клиентов B
  assert.match(await byPath('/api/leaky-guests/[id]'), /A → общий объект: в ответе найдены данные объекта оператора B/);
  const page = await byPath('/(op)/leaky/[id]');
  assert.match(page, /ждали 404, получили 200/);
  assert.match(page, /найдены данные объекта оператора B/);
});
