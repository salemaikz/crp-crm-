// Запись ревизий настроек (README §2.3): блокировка, expectedRev, проверка набора целиком, хэш,
// полный документ области, аудит. Документ и его куски в аудит и логи не попадают.
import { config as coreConfig } from '@crm/core';
import type { ConfigMigration, Json, JsonObject, RevisionSource } from '@crm/core/config';

// Ядро в production — один файл (D-101): значения берём только из корня '@crm/core'
const { CONFIG_SCHEMA_VERSION, ConfigInvalidError, GLOBAL_SCOPE, configHash, deepEqual, lastPresetDoc, nextRev, validateConfigSet } = coreConfig;
import { writeAudit, type AuditAction } from '../audit';
import { getDb, isUniqueViolation, now as clock } from '../db';
import { CONFIG_WRITE_LOCK_KEY } from '../db/locks';
import { docOf, invalidateConfigCache } from './active';
import { ensureSpace, ensureTeam, insertRevision, listRevisionHeads, listSpaces, loadCompatible, seedSeriesIfEmpty, syncSpaceFlags } from './repo';

/** Ожидаемая ревизия не совпала или гонка по (scope, rev): в UI — HTTP 409. */
export class ConfigConflictError extends Error {
  override name = 'ConfigConflictError';
}

export type WriteDocs = { global?: Json; spaces?: Record<string, Json> };

export type WriteConfigInput = {
  /** Новые документы областей: `global` и по ключу пространства. Остальные области — текущие. */
  docs: WriteDocs;
  source: RevisionSource;
  /** Ожидаемая текущая rev по области (`global` или ключ пространства): не совпала — ConfigConflictError. */
  expectedRev?: Record<string, number>;
  /** Только source='preset': собранный пресет области — база следующего обновления (D-061). */
  presetDocs?: WriteDocs;
  note?: string;
  authorId: string | null;
  now?: number;
  /** Только apply: создать пространства и команды, стартовые серии (README §2.4). */
  project?: boolean;
  /** Для тестов миграций настроек: версия схемы записи и реестр миграций. */
  schemaVersion?: number;
  migrations?: readonly ConfigMigration[];
};

export type WrittenScope = { scope: string; scopeId: string; rev: number; hash: string };
export type WriteResult = { written: WrittenScope[]; unchanged: string[] };

const AUDIT_BY_SOURCE: Record<RevisionSource, AuditAction> = {
  preset: 'config.preset',
  rollback: 'config.rollback',
  migration: 'config.migrate',
  ui: 'config.write',
  cli: 'config.write',
};

export async function writeConfig(input: WriteConfigInput): Promise<WriteResult> {
  const target = input.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  const db = await getDb();
  const now = input.now ?? clock();
  if (input.source === 'preset' && !input.presetDocs) throw new Error('writeConfig: для source=preset нужен presetDocs');
  try {
    const result = await db.tx(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${CONFIG_WRITE_LOCK_KEY})`;

      const newGlobal = input.docs.global;
      const declared = declaredSpaces(newGlobal);
      let spaces = await listSpaces(sql);
      if (input.project) {
        for (const s of declared) if (!spaces.some((x) => x.key === s.key)) await ensureSpace(sql, s.key, now);
        spaces = await listSpaces(sql);
      }
      const idOf = new Map(spaces.map((s) => [s.key, s.id]));
      for (const k of Object.keys(input.docs.spaces ?? {})) if (!idOf.has(k)) throw new ConfigInvalidError([{ path: `spaces.${k}`, message: `пространства «${k}» нет в таблице spaces` }]);

      // Текущие совместимые ревизии (в формате схемы записи)
      const scopes = [{ name: GLOBAL_SCOPE, id: GLOBAL_SCOPE, kind: 'global' as const }, ...spaces.map((s) => ({ name: s.key, id: s.id, kind: 'space' as const }))];
      const cur = new Map<string, { rev: number; hash: string; schemaVersion: number; doc: JsonObject }>();
      for (const s of scopes) {
        const r = await loadCompatible(sql, s.id, target);
        if (r) cur.set(s.name, { rev: r.rev, hash: r.hash, schemaVersion: r.schemaVersion, doc: docOf(r, s.kind, input.migrations, target) });
      }

      for (const [name, exp] of Object.entries(input.expectedRev ?? {})) {
        const have = cur.get(name)?.rev ?? 0;
        if (have !== exp) throw new ConfigConflictError(`область «${name}» изменилась: ожидалась ревизия ${exp}, сейчас ${have}`);
      }

      // Набор «текущие + новые» проверяется целиком до записи
      const nextDoc = (name: string): Json | undefined => (name === GLOBAL_SCOPE ? input.docs.global : input.docs.spaces?.[name]) ?? cur.get(name)?.doc;
      const set = {
        global: nextDoc(GLOBAL_SCOPE),
        spaces: Object.fromEntries(spaces.map((s) => [s.key, nextDoc(s.key)]).filter(([, d]) => d !== undefined)),
      };
      const check = validateConfigSet(set);
      if (!check.ok) throw new ConfigInvalidError(check.issues);

      const written: WrittenScope[] = [];
      const unchanged: string[] = [];
      for (const s of scopes) {
        const changing = s.name === GLOBAL_SCOPE ? input.docs.global : input.docs.spaces?.[s.name];
        if (changing === undefined) continue;
        const hash = await configHash(changing);
        const have = cur.get(s.name);
        const heads = await listRevisionHeads(sql, s.id);
        const presetDoc = input.source === 'preset' ? ((s.name === GLOBAL_SCOPE ? input.presetDocs?.global : input.presetDocs?.spaces?.[s.name]) ?? null) : null;
        if (input.source === 'preset' && presetDoc === null) throw new Error(`writeConfig: нет presetDocs для области «${s.name}»`);
        const sameDoc = have !== undefined && have.hash === hash && have.schemaVersion === target;
        const samePreset = input.source !== 'preset' || deepEqual(lastPresetDoc(heads, target), presetDoc ?? undefined);
        if (sameDoc && samePreset) {
          unchanged.push(s.name);
          continue;
        }
        const rev = nextRev(heads);
        await insertRevision(sql, {
          scope: s.id,
          rev,
          schemaVersion: target,
          doc: changing,
          hash,
          source: input.source,
          presetDoc,
          note: input.note ?? '',
          authorId: input.authorId,
          now,
        });
        await writeAudit(sql, {
          actorId: input.authorId,
          action: AUDIT_BY_SOURCE[input.source],
          entity: 'config',
          entityId: s.id,
          spaceId: s.kind === 'space' ? s.id : null,
          meta: { scope: s.name, rev, hash, source: input.source },
          createdAt: now,
        });
        written.push({ scope: s.name, scopeId: s.id, rev, hash });
      }

      if (input.project && check.ok) {
        await syncSpaceFlags(sql, check.value.global.spaces);
        for (const [key, doc] of Object.entries(check.value.spaces)) {
          const spaceId = idOf.get(key);
          if (!spaceId) continue;
          for (const t of doc.teams) await ensureTeam(sql, spaceId, t.key, t.archived === true, now);
          await seedSeriesIfEmpty(sql, spaceId, doc.booking.seedSeries, now);
        }
      }
      return { written, unchanged };
    });
    return result;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConfigConflictError('ревизия с этим номером уже записана: повторите');
    throw e;
  } finally {
    invalidateConfigCache();
  }
}

function declaredSpaces(global: Json | undefined): { key: string }[] {
  const g = global as { spaces?: unknown } | null | undefined;
  if (!g || !Array.isArray(g.spaces)) return [];
  return g.spaces.filter((s): s is { key: string } => typeof s === 'object' && s !== null && typeof (s as { key?: unknown }).key === 'string');
}
