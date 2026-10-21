// UI-8 и UI-9 (D-319): подписи истории сделки по виду события и дата записи общим форматом, а не ISO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingDayLabel, historyLabelKey } from '../../../src/app/(mgr)/deals/_components/dealFormat';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const deals = JSON.parse(readFileSync(join(ROOT, 'messages/ru/deals.json'), 'utf8')) as { history: Record<string, string> };

// Виды событий, которые журнал сделки отдаёт странице (deals/read.ts, repo.read.ts)
const KINDS = ['deal.created', 'deal.stage', 'deal.won', 'deal.lost', 'deal.purchase_edited', 'deal.purchase_cancelled', 'handoff.created', 'note.created'];

test('история сделки: у каждого вида события своя подпись, а не «Событие»', () => {
  for (const kind of KINDS) {
    const key = historyLabelKey(kind, (k) => k in deals.history);
    assert.notEqual(key, 'other', `${kind}: подпись не найдена`);
    assert.ok(deals.history[key], `${kind}: нет ключа history.${key}`);
    assert.notEqual(deals.history[key], deals.history.other);
  }
});

test('история сделки: неизвестный вид — «Событие»; точка в виде не ломает путь ключа next-intl', () => {
  assert.equal(historyLabelKey('unknown.kind', (k) => k in deals.history), 'other');
  for (const k of Object.keys(deals.history)) assert.ok(!k.includes('.'), `ключ ${k} с точкой next-intl читает как вложенность`);
});

test('запись в блоке сделки: дата общим форматом, без ISO', () => {
  assert.equal(bookingDayLabel('2026-10-21', 'ru'), '21 окт.');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(bookingDayLabel('2026-10-21', 'ru')));
  assert.equal(bookingDayLabel('мусор', 'ru'), 'мусор');
});
