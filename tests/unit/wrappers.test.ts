// Статическая проверка обёрток (ARCHITECTURE §5.3): route handler, server action и страница/layout с данными
// обязаны быть обёрнуты в route/publicRoute/action/page из src/server/access. Сопоставление по AST TypeScript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeActionFile, analyzePageFile, analyzeRouteFile, scanApp, type AppUnit } from '../helpers/appScan';
import { STATIC_POLICY } from '../helpers/staticPolicy';
import { wrapperViolations, type WrapperPolicy } from '../helpers/wrapperRules';

const EMPTY: WrapperPolicy = { publicRoutes: {}, unwrappedByDesign: [], legacyUnwrapped: {} };
const check = (units: AppUnit[], policy: WrapperPolicy = EMPTY) => wrapperViolations(units, policy);
const routeSrc = (file: string, src: string) => analyzeRouteFile(`src/app/${file}`, src);

test('все route handler, server actions и страницы с данными обёрнуты (src/app)', () => {
  const units = scanApp();
  assert.ok(units.some((u) => u.kind === 'route'), 'каркас: маршруты найдены');
  assert.ok(units.some((u) => u.kind === 'page'), 'каркас: страницы найдены');
  assert.deepEqual(wrapperViolations(units, STATIC_POLICY), []);
});

test('самопроверка: заведомо плохой route handler без обёртки ловится', () => {
  const bad = routeSrc('api/leak/route.ts', `export async function GET() { return Response.json({ secret: 1 }); }`);
  assert.equal(bad.length, 1);
  assert.equal(check(bad).length, 1);
  assert.match(check(bad)[0] ?? '', /без обёртки/);
  // стрелочная функция и реэкспорт тоже не обёртка
  assert.equal(check(routeSrc('api/a/route.ts', `export const POST = async () => new Response();`)).length, 1);
  assert.equal(check(routeSrc('api/b/route.ts', `export { GET } from './impl';`)).length, 1);
  assert.equal(check(routeSrc('api/c/route.ts', `async function h() {}\nexport { h as DELETE };`)).length, 1);
  // функция с именем route, не импортированная из доступа, — не обёртка
  assert.equal(check(routeSrc('api/d/route.ts', `import { route } from './mine';\nexport const GET = route({ perm: 'x' }, async () => 1);`)).length, 1);
  assert.equal(check(routeSrc('api/e/route.ts', `const route = (a: unknown, b: unknown) => b;\nexport const GET = route({}, async () => 1);`)).length, 1);
  // своя обёртка поверх чужой — тоже мимо (обёртка обязана быть прямым вызовом)
  assert.equal(check(routeSrc('api/f/route.ts', `import { route } from '@/server/access';\nconst w = (f: unknown) => f;\nexport const GET = w(async () => route({ perm: 'authenticated' }, async () => 1));`)).length, 1);
});

test('самопроверка: настоящие обёртки принимаются (прямой вызов, алиас, namespace, через локальную const)', () => {
  const ok = (file: string, src: string) => {
    const units = routeSrc(file, src);
    assert.ok(units.length >= 1, src);
    assert.deepEqual(check(units), [], src);
    return units;
  };
  const u = ok('api/cards/[id]/route.ts', `import { route } from '@/server/access';\nexport const GET = route({ perm: 'card.read', target: 'object' }, async () => 1);\nexport const PATCH = route({ perm: 'card.edit', target: 'object' }, async () => 1);`);
  assert.equal(u[0]?.wrapped?.perm, 'card.read');
  assert.equal(u[0]?.wrapped?.target, 'object');
  ok('api/a/route.ts', `import { route as guarded } from '@/server/access';\nexport const GET = guarded({ perm: 'authenticated' }, async () => 1);`);
  ok('api/b/route.ts', `import * as access from '@/server/access';\nexport const GET = access.route({ perm: 'authenticated' }, async () => 1);`);
  ok('api/c/route.ts', `import { route } from '../../../server/access/wrappers';\nconst h = route({ perm: 'authenticated' }, async () => 1);\nexport { h as GET };`);
  ok('api/d/route.ts', `import { route } from '@/server/access';\nconst h = route({ perm: 'authenticated' }, async () => 1);\nexport const GET = h, POST = h;`);
  ok('api/e/route.ts', `import { route } from '@/server/access';\nexport const GET = route({ perm: 'authenticated' }, async () => 1) satisfies unknown;`);
  // не-методы экспортировать можно
  assert.equal(routeSrc('api/f/route.ts', `export const dynamic = 'force-dynamic';`).length, 0);
});

test('самопроверка: публичный маршрут только из явного списка; список не ветшает', () => {
  const pub = routeSrc('api/hook/route.ts', `import { publicRoute } from '@/server/access';\nexport const POST = publicRoute({ reason: 'webhook', origin: 'skip' }, async () => 1);`);
  assert.equal(pub[0]?.wrapped?.fn, 'publicRoute');
  assert.equal(pub[0]?.wrapped?.reason, 'webhook');
  const out = check(pub);
  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /вне явного списка/);
  assert.deepEqual(check(pub, { ...EMPTY, publicRoutes: { 'POST /api/hook': 'webhook' } }), []);
  // запись в списке без маршрута, и маршрут, обёрнутый не publicRoute
  assert.match(check([], { ...EMPTY, publicRoutes: { 'POST /api/ghost': 'x' } })[0] ?? '', /маршрута нет/);
  const closed = routeSrc('api/hook/route.ts', `import { route } from '@/server/access';\nexport const POST = route({ perm: 'authenticated' }, async () => 1);`);
  assert.match(check(closed, { ...EMPTY, publicRoutes: { 'POST /api/hook': 'x' } })[0] ?? '', /обёрнут route/);
  // долг: уже обёрнутое нужно убрать из legacyUnwrapped; устаревшая запись — ошибка
  assert.match(check(closed, { ...EMPTY, legacyUnwrapped: { 'POST /api/hook': 'P3' } }).join('\n'), /уже обёрнут/);
  assert.match(check([], { ...EMPTY, legacyUnwrapped: { 'POST /api/ghost': 'P3' } })[0] ?? '', /устаревшая/);
  // публичный маршрут не может быть обёрнут page()/action()
  const wrongKind = routeSrc('api/x/route.ts', `import { action } from '@/server/access';\nexport const POST = action({ perm: 'authenticated' }, async () => 1);`);
  assert.match(check(wrongKind)[0] ?? '', /не подходит/);
});

test('самопроверка: страницы и layout, читающие данные, требуют page()', () => {
  const pageOf = (src: string, file = 'src/app/(op)/cards/page.tsx') => analyzePageFile(file, src);
  // импорт из src/server/** — чтение данных
  const bad = pageOf(`import { listCards } from '@/server/domain/cards';\nexport default async function P() { return <div>{await listCards()}</div>; }`);
  assert.equal(bad[0]?.readsData, true);
  assert.match(check(bad)[0] ?? '', /без обёртки page\(\)/);
  // динамический параметр пути — тоже чтение
  const dyn = pageOf(`export default async function P({ params }: { params: Promise<{ id: string }> }) { return <div>{(await params).id}</div>; }`, 'src/app/(op)/cards/[id]/page.tsx');
  assert.equal(dyn[0]?.readsData, true);
  assert.equal(check(dyn).length, 1);
  // layout, читающий данные
  const lay = pageOf(`import { cookies } from 'next/headers';\nexport default async function L({ children }: { children: React.ReactNode }) { await cookies(); return children; }`, 'src/app/(op)/layout.tsx');
  assert.equal(lay[0]?.layout, true);
  assert.equal(lay[0]?.path, '/(op)/layout');
  assert.equal(check(lay).length, 1);
  // fetch
  assert.equal(check(pageOf(`export default async function P() { const r = await fetch('/x'); return <p>{r.status}</p>; }`)).length, 1);
  // обёрнуто page() — в порядке, также через локальную const
  const ok = pageOf(`import { page } from '@/server/access';\nimport { listCards } from '@/server/domain/cards';\nconst Page = page({ perm: 'card.read' }, async () => <div>{await listCards()}</div>);\nexport default Page;`);
  assert.equal(ok[0]?.wrapped?.fn, 'page');
  assert.deepEqual(check(ok), []);
  // статическая страница и клиентская страница без данных — обёртка не нужна
  assert.deepEqual(check(pageOf(`export default function P() { return <p>привет</p>; }`, 'src/app/(auth)/login/page.tsx')), []);
  assert.deepEqual(check(pageOf(`'use client';\nimport { db } from '@/server/platform/db';\nexport default function P() { return <p>{String(db)}</p>; }`)), []);
  // route() на странице — не то
  assert.match(check(pageOf(`import { route } from '@/server/access';\nimport { x } from '@/server/domain/x';\nexport default route({ perm: 'authenticated' }, async () => x);`))[0] ?? '', /не подходит/);
});

test('самопроверка: server actions — каждый экспорт файла use server обёрнут action()', () => {
  const acts = (src: string) => analyzeActionFile('src/app/(op)/cards/actions.ts', src);
  const bad = acts(`'use server';\nexport async function renameCard(id: string) { return id; }`);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]?.path, '(op)/cards/actions.ts#renameCard');
  assert.match(check(bad)[0] ?? '', /server action без обёртки/);
  const mixed = acts(`'use server';\nimport { action } from '@/server/access';\nexport const good = action({ perm: 'card.edit', target: 'object' }, async () => 1);\nexport const evil = async () => 2;\nexport type T = string;`);
  assert.equal(mixed.length, 2);
  assert.equal(check(mixed).length, 1);
  assert.match(check(mixed)[0] ?? '', /evil/);
  // встроенный 'use server' внутри компонента обернуть нельзя — нарушение
  const inline = analyzeActionFile('src/app/x/page.tsx', `export default function P() { async function save() { 'use server'; return 1; } return <form action={save} />; }`);
  assert.equal(inline.length, 1);
  assert.equal(check(inline).length, 1);
  // файл без директивы — не action-файл
  assert.equal(acts(`export async function plain() { return 1; }`).length, 0);
  assert.deepEqual(check(acts(`'use server';\nimport { action } from '@/server/access';\nexport default action({ perm: 'authenticated' }, async () => 1);`)), []);
});
