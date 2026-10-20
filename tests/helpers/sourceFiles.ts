// Обход исходников для статических тестов (слои, стоп-слова).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);

/** Все файлы каталога рекурсивно (пути относительно корня репозитория, с '/'). Нет каталога — пусто. */
export function walk(dir: string, exts: readonly string[]): string[] {
  const abs = join(ROOT, dir);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  const rec = (d: string) => {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) rec(p);
      else if (exts.some((e) => name.endsWith(e))) out.push(relative(ROOT, p).split('\\').join('/'));
    }
  };
  rec(abs);
  return out.sort();
}

export function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}
