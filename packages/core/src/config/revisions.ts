// Ревизии настроек (`config_revisions`, CONFIG §2, D-060): выбор совместимой ревизии и номер новой.
// Чистые функции; SQL и кэш — src/server/platform/config (README.md рядом).
import type { Json } from './json.js';
import type { GlobalConfigV1, SpaceConfigV1 } from './schema/v1.js';
import { CONFIG_SCHEMA_VERSION } from './version.js';

/** Значения `config_revisions.source` (CHECK в схеме БД v1). */
export const REVISION_SOURCES = ['preset', 'ui', 'cli', 'migration', 'rollback'] as const;
export type RevisionSource = (typeof REVISION_SOURCES)[number];

/** Область документа: `global` или id пространства (`spaces.id`, не ключ). */
export const GLOBAL_SCOPE = 'global';

export type RevisionHead = { rev: number; schemaVersion: number };

export type ConfigRevision = RevisionHead & {
  id: string;
  scope: string;
  doc: Json;
  hash: string;
  source: RevisionSource;
  presetDoc: Json | null;
  note: string;
  authorId: string | null;
  createdAt: number;
};

/**
 * Последняя совместимая ревизия: максимальная `rev` со `schemaVersion ≤ supported` (D-060). Так после
 * отката продукта прежняя версия читает свою ревизию, а не документ новой схемы.
 */
export function pickCompatible<T extends RevisionHead>(revs: readonly T[], supported: number = CONFIG_SCHEMA_VERSION): T | undefined {
  let best: T | undefined;
  for (const r of revs) if (r.schemaVersion <= supported && (!best || r.rev > best.rev)) best = r;
  return best;
}

/**
 * Номер новой ревизии: максимум по области среди **всех** версий схемы + 1, а не «совместимая + 1»:
 * `(scope, rev)` уникален, ревизии новой схемы после отката остаются в таблице.
 */
export function nextRev(revs: readonly RevisionHead[]): number {
  return revs.reduce((m, r) => Math.max(m, r.rev), 0) + 1;
}

/**
 * База трёхстороннего слияния: `preset_doc` последней ревизии `source=preset` среди совместимых.
 * Нет такой ревизии — undefined (тогда всё, что отличается от нового пресета, считается правкой клиента).
 */
export function lastPresetDoc<T extends RevisionHead & { source: RevisionSource; presetDoc: Json | null }>(
  revs: readonly T[],
  supported: number = CONFIG_SCHEMA_VERSION,
): Json | undefined {
  const presets = revs.filter((r) => r.source === 'preset' && r.presetDoc !== null);
  return pickCompatible(presets, supported)?.presetDoc ?? undefined;
}

/** Что отдаёт геттер настроек: проверенный набор и ревизии, из которых он собран. */
export type ActiveConfig = {
  /** Номер ревизии global (для аудита и Viewer.configRev). */
  rev: number;
  /**
   * Ревизия и документ целиком (`doc`); поля документа продублированы на верхнем уровне
   * (`global.org`, `global.roles`, `global.theme`, …) — так их читают потребители (доступ, вход, тема).
   */
  global: GlobalConfigV1 & { rev: number; hash: string; doc: GlobalConfigV1 };
  /** По ключу пространства (`spaces.key`). */
  spaces: Record<string, { spaceId: string; rev: number; hash: string; doc: SpaceConfigV1 }>;
  /** Версия схемы, к которой приведены документы (= CONFIG_SCHEMA_VERSION сборки). */
  schemaVersion: number;
};
