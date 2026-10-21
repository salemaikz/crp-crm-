// Каждый вид уведомления, который создаёт код, имеет текст в локали и ссылку на экран (иначе в колокольчике «Новое уведомление»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hrefForKind, isKnownKind } from '../../../src/app/(op)/notifications/kinds';

const root = join(import.meta.dirname, '..', '..', '..');
const msgs = JSON.parse(readFileSync(join(root, 'messages', 'ru', 'notify.json'), 'utf8')) as { kinds: Record<string, string> };

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Виды, которые код передаёт в вставку уведомления (`insert…Notification…(… kind: 'x')`) или пишет в SQL литералом. */
function createdKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const file of walk(join(root, 'src', 'server'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/insert\w*Notifications?\([^)]*?kind:\s*'([a-z_]+)'/gs)) kinds.add(m[1]!);
    for (const m of src.matchAll(/out\.notifications\.push\(\{[^}]*?kind:\s*'([a-z_]+)'/gs)) kinds.add(m[1]!);
    for (const m of src.matchAll(/INSERT INTO notifications[\s\S]{0,400}?SELECT[^;]*?'([a-z_]+)'\s*,\s*''/g)) kinds.add(m[1]!);
  }
  return kinds;
}

test('виды уведомлений из кода найдены (страховка от пустого сканирования)', () => {
  const kinds = createdKinds();
  for (const k of ['absence_acting', 'absence_no_substitute', 'task_assigned', 'task_comment', 'cards_assigned']) {
    assert.ok(kinds.has(k), `сканер не нашёл ${k}`);
  }
});

test('для каждого созданного вида есть текст и ссылка', () => {
  for (const kind of createdKinds()) {
    assert.ok(msgs.kinds[kind], `нет текста ${kind}`);
    assert.ok(isKnownKind(kind), `нет вида в HREF ${kind}`);
    assert.ok(hrefForKind(kind), `нет ссылки ${kind}`);
  }
});
