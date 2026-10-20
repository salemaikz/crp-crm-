// Загрузка манифестов изоляции tests/isolation/manifest/*.ts (по файлу на модуль; ведут потоки).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ManifestEntry, ModuleManifest } from './manifest';

export const MANIFEST_DIR = join(import.meta.dirname, '..', 'manifest');

export async function loadManifests(dir = MANIFEST_DIR): Promise<ModuleManifest[]> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
  } catch {
    return []; // каталога ещё нет: манифесты появляются с маршрутами потоков
  }
  const out: ModuleManifest[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default?: ModuleManifest };
    if (!mod.default || !Array.isArray(mod.default.entries)) throw new Error(`манифест ${f}: нужен export default defineManifest(...)`);
    out.push(mod.default);
  }
  return out;
}

/** Все записи всех модулей; дубли «метод путь» между модулями — ошибка. */
export async function allEntries(dir = MANIFEST_DIR): Promise<Array<ManifestEntry & { module: string }>> {
  const seen = new Map<string, string>();
  const out: Array<ManifestEntry & { module: string }> = [];
  for (const m of await loadManifests(dir)) {
    for (const e of m.entries) {
      const key = `${e.method} ${e.path}`;
      const prev = seen.get(key);
      if (prev) throw new Error(`манифест: ${key} описан в ${prev} и ${m.module}`);
      seen.set(key, m.module);
      out.push({ ...e, module: m.module });
    }
  }
  return out;
}
