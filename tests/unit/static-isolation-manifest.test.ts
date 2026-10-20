// Покрытие манифеста изоляции (ARCHITECTURE §5.3): каждый маршрут и страница из src/app описаны в
// tests/isolation/manifest/<модуль>.ts. Нет записи — тест падает. Работает на будущих модулях без правок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeActionFile, analyzePageFile, analyzeRouteFile, scanApp } from '../helpers/appScan';
import { coverageViolations, type Entry } from '../helpers/manifestCoverage';
import { STATIC_POLICY } from '../helpers/staticPolicy';
import { allEntries } from '../isolation/harness/load';

const PUBLIC = STATIC_POLICY.publicRoutes;
const NONE = {};
const entry = (o: Partial<Entry> & Pick<Entry, 'kind' | 'path'>): Entry => ({ module: 'x', method: 'GET', perm: 'authenticated', target: 'section', mutation: false, ...o });

test('каждый маршрут, server action и страница из src/app есть в манифесте изоляции', async () => {
  const entries = await allEntries();
  assert.ok(entries.length > 0, 'манифесты загружены');
  assert.deepEqual(coverageViolations(scanApp(), entries, PUBLIC), []);
});

test('самопроверка: маршрут без записи в манифесте ловится', () => {
  const units = analyzeRouteFile('src/app/api/cards/[id]/route.ts', `import { route } from '@/server/access';\nexport const GET = route({ perm: 'card.read', target: 'object' }, async () => 1);`);
  const out = coverageViolations(units, [], NONE);
  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /нет записи в tests\/isolation\/manifest/);
  const ok = entry({ kind: 'route', path: '/api/cards/[id]', perm: 'card.read', target: 'object', idParam: { name: 'id', entity: 'card' } });
  assert.deepEqual(coverageViolations(units, [ok], NONE), []);
});

test('самопроверка: страница, layout с данными и server action без записи ловятся; layout без данных — нет', () => {
  const page = analyzePageFile('src/app/(op)/cards/[id]/page.tsx', `export default async function P({ params }: { params: Promise<{ id: string }> }) { return <p>{(await params).id}</p>; }`);
  const layoutData = analyzePageFile('src/app/(op)/layout.tsx', `import { getSession } from '@/server/platform/auth';\nexport default async function L({ children }: { children: React.ReactNode }) { await getSession(); return children; }`);
  const layoutPlain = analyzePageFile('src/app/(auth)/layout.tsx', `export default function L({ children }: { children: React.ReactNode }) { return children; }`);
  const act = analyzeActionFile('src/app/(op)/cards/actions.ts', `'use server';\nexport async function rename() { return 1; }`);
  const units = [...page, ...layoutData, ...layoutPlain, ...act];
  const out = coverageViolations(units, [], NONE);
  assert.equal(out.length, 3, out.join('\n'));
  assert.ok(out.some((m) => /страница GET \/\(op\)\/cards\/\[id\]/.test(m)));
  assert.ok(out.some((m) => /layout GET \/\(op\)\/layout/.test(m)));
  assert.ok(out.some((m) => /server action \(op\)\/cards\/actions\.ts#rename/.test(m)));
  // записи: путь с группой и без группы равноценны
  const entries = [
    entry({ kind: 'page', path: '/cards/[id]', target: 'object', idParam: { name: 'id', entity: 'card' } }),
    entry({ kind: 'page', path: '/(op)/layout' }),
    entry({ kind: 'action', path: '(op)/cards/actions.ts#rename', method: 'POST', mutation: true, touches: ['cards'] }),
  ];
  assert.deepEqual(coverageViolations(units, entries, NONE), []);
});

test('самопроверка: устаревшие и противоречивые записи манифеста ловятся', () => {
  const units = analyzeRouteFile('src/app/api/cards/[id]/route.ts', `import { route } from '@/server/access';\nexport const POST = route({ perm: 'card.edit', target: 'object' }, async () => 1);`);
  const good = entry({ kind: 'route', method: 'POST', path: '/api/cards/[id]', perm: 'card.edit', target: 'object', idParam: { name: 'id', entity: 'card' }, mutation: true, touches: ['cards'] });
  assert.deepEqual(coverageViolations(units, [good], NONE), []);
  const m = (e: Entry | Entry[], u = units) => coverageViolations(u, Array.isArray(e) ? e : [e], NONE).join('\n');
  assert.match(m({ ...good, perm: 'card.read' }), /в обёртке perm='card.edit', в манифесте 'card.read'/);
  assert.match(m({ ...good, target: 'section', idParam: undefined }), /target='object', в манифесте 'section'/);
  assert.match(m([good, entry({ kind: 'route', path: '/api/ghost' })]), /устаревшая запись/);
  assert.match(m({ ...good, touches: [] }), /мутация без touches/);
  assert.match(m({ ...good, touches: ['cards; DROP TABLE x'] }), /недопустимое имя таблицы/);
  assert.match(m({ ...good, path: '/api/cards/[other]', idParam: { name: 'id', entity: 'card' } }), /нет такого маршрута|idParam/);
  assert.match(m({ ...good, perm: 'public', target: 'section', idParam: undefined }), /perm='public' допустим только у publicRoute/);
  // публичная запись — только из явного списка; список — только с записью
  const hook = entry({ kind: 'route', method: 'POST', path: '/api/hook', perm: 'public', mutation: true, touches: ['stop_list'] });
  const hookUnit = analyzeRouteFile('src/app/api/hook/route.ts', `import { publicRoute } from '@/server/access';\nexport const POST = publicRoute({ reason: 'webhook', origin: 'skip' }, async () => 1);`);
  assert.match(m(hook, hookUnit), /нет в явном списке/);
  assert.deepEqual(coverageViolations(hookUnit, [hook], { 'POST /api/hook': 'webhook' }), []);
  assert.match(coverageViolations([], [], { 'POST /api/hook': 'webhook' }).join('\n'), /не описан в манифесте/);
  assert.match(m({ ...hook, perm: 'authenticated' }, hookUnit), /обёрнут publicRoute\(\), в манифесте perm='authenticated'/);
});
