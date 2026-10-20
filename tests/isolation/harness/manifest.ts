// Формат манифеста изоляции (ARCHITECTURE §5.3, D-017). Каждый поток ведёт свой файл
// tests/isolation/manifest/<модуль>.ts: `export default defineManifest('<модуль>', [...])`.
// Статический обход (P4b) сверяет, что каждый route handler, server action и страница с данными
// описаны здесь; прогон tests/isolation/run.test.ts ходит по записям от лица синтетических ролей.
import type { Requirement } from '../../../src/server/access/wrappers';
import type { ScopedEntity } from '../../../src/server/access/types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ManifestEntry = {
  kind: 'route' | 'page' | 'action';
  /**
   * route и page — путь Next от src/app без групп или с ними: '/api/cards/[id]', '/(op)/cards/[id]'.
   * action — '<файл от src/app>#<имя экспорта>'.
   */
  path: string;
  /** Для route — метод; page — GET; action — POST. */
  method: HttpMethod;
  /** То же требование, что в обёртке; 'public' — publicRoute. */
  perm: Requirement | 'public';
  target: 'object' | 'section';
  /** Параметр пути с id объекта: прогон подставит id объекта оператора B и несуществующий id. */
  idParam?: { name: string; entity: ScopedEntity };
  /** Пример тела для мутаций (синтетика, номера +7 709 …). */
  sampleBody?: unknown;
  /** Меняет ли данные: прогон снимает снимок таблиц `touches` до и после и ждёт равенства у чужих. */
  mutation: boolean;
  touches?: readonly string[];
  /** Мутация безопасности D-054: прогон проверяет, что лицензия «только чтение» её не блокирует. */
  securityMutation?: boolean;
};

export type ModuleManifest = { module: string; entries: readonly ManifestEntry[] };

export function defineManifest(module: string, entries: readonly ManifestEntry[]): ModuleManifest {
  if (!/^[a-z][a-z0-9_-]*$/.test(module)) throw new Error(`манифест: имя модуля ${module}`);
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.method} ${e.path}`;
    if (seen.has(key)) throw new Error(`манифест ${module}: дубль ${key}`);
    seen.add(key);
    if (e.target === 'object' && !e.idParam) throw new Error(`манифест ${module}: ${key} — объектному входу нужен idParam`);
    if (e.mutation && e.method === 'GET') throw new Error(`манифест ${module}: ${key} — GET не может быть мутацией`);
  }
  return { module, entries };
}
