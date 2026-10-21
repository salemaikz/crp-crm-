// UI-8 и UI-9 (D-319): подписи истории сделки по виду события и дата записи общим форматом, а не ISO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingDayLabel, historyLabelKey } from '../../../src/app/(mgr)/deals/_components/dealFormat';
import { DEAL_HISTORY_KINDS } from '../../../src/server/domain/timeline/kinds';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const deals = JSON.parse(readFileSync(join(ROOT, 'messages/ru/deals.json'), 'utf8')) as { history: Record<string, string> };

/** Виды `kind: 'deal.…' | 'booking.…' | 'handoff.…' | 'task.…' | 'note.…'`, которые домены пишут в ленту. */
function kindsWrittenByDomains(): Set<string> {
  const dir = join(ROOT, 'src/server/domain');
  const out = new Set<string>();
  for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/kind: '((?:deal|booking|handoff|task|note)\.[a-z_]+)'/g)) out.add(m[1] as string);
    // объединения видов в типах вставки (`kind: 'task.created' | 'task.done' | …`)
    for (const m of text.matchAll(/kind: ((?:'[a-z_.]+'\s*\|\s*)+'[a-z_.]+')/g)) for (const k of (m[1] as string).matchAll(/'((?:deal|booking|handoff|task|note)\.[a-z_]+)'/g)) out.add(k[1] as string);
  }
  return out;
}

test('история сделки: список видов — все виды, которые модули пишут с deal_id (запись, передача, задачи, заметки)', () => {
  const listed = new Set<string>(DEAL_HISTORY_KINDS);
  const written = kindsWrittenByDomains();
  // виды записи и передачи пишутся с deal_id: история встречи консультанта — это они (снимок 10)
  for (const k of ['booking.created', 'booking.status', 'booking.result', 'booking.assigned', 'booking.moved', 'handoff.accepted', 'task.created']) assert.ok(written.has(k), `${k} пишется в коде`);
  for (const k of written) assert.ok(listed.has(k), `${k}: пишется в ленту, но нет в DEAL_HISTORY_KINDS`);
});

test('история сделки: у каждого вида события своя подпись, а не «Событие»', () => {
  for (const kind of DEAL_HISTORY_KINDS) {
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
