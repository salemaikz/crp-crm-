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
  // потеряла отступы оболочки (ревью D-319)
  const all = files.map((f) => ({ f, src: readFileSync(f, 'utf8') }));
  const bad: string[] = [];
  for (const { f, src } of all) {
    if (!/<PageHeader\b/.test(src) || /<Page\b/.test(src)) continue;
    const names = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]!);
    const users = all.filter((o) => o.f !== f && names.some((n) => new RegExp(`<${n}\\b`).test(o.src)));
    if (users.length === 0 || users.some((u) => !/<Page\b/.test(u.src))) bad.push(relative(ROOT, f));
  }
  assert.deepEqual(bad, []);
});
