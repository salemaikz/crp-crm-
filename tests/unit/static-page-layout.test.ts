// D-319: у страницы один владелец боковых отступов и ширины — Page из кита. Своих <main> с max-w-*/px-* нет,
// страницы с данными рендерят Page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'src/app')), ...walk(join(ROOT, 'src/ui'))].filter((f) => !f.includes(`${join('src', 'ui', 'kit')}`));

test('нет <main> со своими max-w-* и px-* (ширину и отступы задаёт Page)', () => {
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<main\b[^>]*>/g)) {
      if (/max-w-|\bpx-|\bmx-auto/.test(m[0])) bad.push(relative(ROOT, f));
    }
  }
  assert.deepEqual(bad, []);
});

test('страницы и экраны, которые рисуют <main> сами, не обходят Page', () => {
  const bad = files.filter((f) => /<main\b/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
  assert.deepEqual(bad, []);
});

test('страницы с данными рендерят Page', () => {
  // экраны, чей корневой компонент не Page: редиректы и API-подобные страницы
  const NO_LAYOUT = new Set(['src/app/page.tsx', 'src/app/(auth)/layout.tsx', 'src/app/(op)/call/page.tsx']);
  const missing: string[] = [];
  const dirs = [
    ...walk(join(ROOT, 'src/app')).filter((f) => /(page|Screen|Board|Panel)\.tsx$/.test(f) && !f.includes('/_')),
  ];
  for (const f of dirs) {
    const rel = relative(ROOT, f);
    if (NO_LAYOUT.has(rel)) continue;
    const src = readFileSync(f, 'utf8');
    if (!/export default page</.test(src) && !/Screen\.tsx$/.test(f)) continue;
    // страница-обёртка, которая только отдаёт данные экрану (импортирует *Screen), Page не рисует
    if (/<\w*(Screen|Board)\b/.test(src) && !/<PageHeader/.test(src) && !/<Page\b/.test(src)) continue;
    if (!/<Page\b/.test(src) && /<PageHeader/.test(src)) missing.push(rel);
  }
  assert.deepEqual(missing, []);
});

test('любой компонент с <PageHeader> стоит внутри Page: рисует Page сам или его рисуют только внутри Page', () => {
  // Не по шаблону имён файлов: ветка «только полная выгрузка» отчётов (DataExportOnly) им не подходила и
  // потеряла отступы оболочки (ревью D-319). Проверка по месту вызова, а не по файлу: экран «Записей» импорта
  // (BookingsDetail) вызывался в файле, где Page рисует соседний компонент, и стоял вне Page.
  const all = files.map((f) => ({ f, src: readFileSync(f, 'utf8') }));
  const bad: string[] = [];
  for (const { f, src } of all) {
    const loose = [...src.matchAll(/<PageHeader\b/g)].filter((m) => pageDepth(src, m.index) === 0);
    if (loose.length === 0) continue;
    const names = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]!);
    const calls = all
      .filter((o) => o.f !== f)
      .flatMap((o) => names.flatMap((n) => [...o.src.matchAll(new RegExp(`<${n}\\b`, 'g'))].map((m) => pageDepth(o.src, m.index))));
    if (calls.length === 0 || calls.some((d) => d === 0)) bad.push(relative(ROOT, f));
  }
  assert.deepEqual(bad, []);
});

/** Сколько <Page> открыто к позиции i (по тексту файла). */
function pageDepth(src: string, i: number): number {
  const before = src.slice(0, i);
  return (before.match(/<Page\b/g)?.length ?? 0) - (before.match(/<\/Page>/g)?.length ?? 0);
}

test('новые блоки — на ките: свои классы полей экранов входа (fieldStyles) только у экранов, ждущих UI-5e', () => {
  // Блок push в «Моём аккаунте» (P8b-2) пришёл на этих классах мимо кита и темы — кнопка чёрная (D-319 §1).
  // Список только сокращается: экран, переведённый на кит, из него уходит.
  const LEGACY = new Set(['src/app/(auth)/account/AccountForms.tsx', 'src/app/(auth)/invite/InviteForm.tsx', 'src/app/(auth)/login/LoginForm.tsx']);
  const bad = files.filter((f) => /from '[./]*fieldStyles'/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f)).filter((f) => !LEGACY.has(f));
  assert.deepEqual(bad, []);
});
