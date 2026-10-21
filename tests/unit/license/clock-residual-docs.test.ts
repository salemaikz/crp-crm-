// Остаток правила часов (D-314 (а), круг 4 красной команды): перевод часов назад с возвратом к last_seen_at хотя бы
// на одну проверку раз в 48 ч держит срок сколько угодно (packages/core/src/license/clock.test.ts, «остаток (а)»).
// Документы, по которым владелец принимает остаток (В-7), не должны обещать предел «48 ч сверх срока» для часов назад
// без правки БД, а оператору — psql вместо команды сброса.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FILES = ['docs/DECISIONS.md', 'docs/ARCHITECTURE.md', 'docs/ops/RUNBOOK.md', 'docs/DEPLOY.md', 'docs/PLAN.md'];
const flat = async (p: string) => (await readFile(p, 'utf8')).replace(/\s+/g, ' ');

test('документы не обещают, что часы назад без правки БД держат срок не больше 48 ч', async () => {
  const stale = [
    /держит срок не дольше 48 ч эпизода/,
    /держат окно не дольше 48 ч эпизода/,
    /Часы назад без правки БД дают до 48 ч сверх срока/,
    /продлевает не больше чем на 48 ч/,
    /возврат часов в одну точку с перезапуском перед каждой проверкой — не держит/,
    /ложный момент сбрасывает владелец через psql \(D-212\); часы назад — время идёт по монотонному времени/,
  ];
  for (const p of FILES) {
    const text = await flat(p);
    const found = stale.filter((re) => re.test(text)).map(String);
    assert.deepEqual(found, [], p);
  }
});

test('остаток с возвратом часов к last_seen_at назван в D-314, §8.4, RUNBOOK, DEPLOY и В-7', async () => {
  const missing: string[] = [];
  for (const p of FILES) if (!/раз в 48 ч/.test(await flat(p))) missing.push(p);
  assert.deepEqual(missing, [], 'нет остатка «возврат часов раз в 48 ч»');
  const plan = await flat('docs/PLAN.md');
  const v7 = plan.slice(plan.indexOf('| В-7 |'), plan.indexOf('| В-8 |'));
  assert.ok(/D-314/.test(v7) && /license-clock reset/.test(v7), 'В-7 не обновлён под D-314');
});
