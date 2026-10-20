// Управление ключами приёма из консоли (`crmctl ingest-key`). Ключи `managed=cli` в интерфейсе CRM не показываются:
// интерфейсу (после 1.11) отдаётся только `uiKeys()`. Секрет показывается один раз при создании, в БД — sha256.
import type { SystemActor } from '@/server/access/systemActor';
import { getActiveConfig } from '@/server/platform/config/active';
import { getDb, newId } from '@/server/platform/db';
import { generateKey } from './keys';
import * as repo from './repo';
import { INGEST_SCOPES, type IngestScope } from './types';

export class KeyInputError extends Error {
  override name = 'KeyInputError';
}

export interface KeyInfo {
  prefix: string;
  spaceKey: string;
  sourceKey: string;
  scopes: IngestScope[];
  managed: 'ui' | 'cli';
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const infoOf = (r: repo.KeyRow): KeyInfo => ({
  prefix: r.prefix,
  spaceKey: r.spaceKey,
  sourceKey: r.sourceKey,
  scopes: r.scopes,
  managed: r.managed,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
});

export function parseScopes(raw: string): IngestScope[] {
  const list = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (list.length === 0) throw new KeyInputError('нужно хотя бы одно разрешение: ' + INGEST_SCOPES.join(', '));
  for (const s of list) if (!(INGEST_SCOPES as readonly string[]).includes(s)) throw new KeyInputError(`неизвестное разрешение «${s}»`);
  return list as IngestScope[];
}

/** Создать ключ. Пространство должно существовать, источник — быть в настройках и иметь вид `ingest`. */
export async function createKey(
  actor: SystemActor,
  input: { spaceKey: string; sourceKey: string; scopes: readonly IngestScope[]; managed: 'ui' | 'cli' },
): Promise<{ key: string; info: KeyInfo }> {
  const db = await getDb();
  const spaceId = await repo.spaceIdByKey(db.sql, input.spaceKey);
  if (!spaceId) throw new KeyInputError(`пространства «${input.spaceKey}» нет`);
  const cfg = await getActiveConfig({ now: actor.now });
  const source = cfg.global.doc.sources.find((s) => s.key === input.sourceKey && !s.archived);
  if (!source) throw new KeyInputError(`источника «${input.sourceKey}» нет в настройках`);
  if (source.kind !== 'ingest') throw new KeyInputError(`источник «${input.sourceKey}» не принимает лиды по API (вид ${source.kind})`);

  const g = generateKey();
  await repo.insertKey(db.sql, {
    id: newId(),
    prefix: g.prefix,
    keyHash: g.keyHash,
    spaceId,
    sourceKey: input.sourceKey,
    scopes: input.scopes,
    managed: input.managed,
    now: actor.now,
  });
  const row = await repo.findKeyByPrefix(db.sql, g.prefix);
  if (!row) throw new Error('ключ не создан');
  return { key: g.key, info: infoOf(row) };
}

/** Все ключи (консоль владельца). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- исполнитель нужен как пропуск: вызвать может только консоль
export async function listKeys(actor: SystemActor): Promise<KeyInfo[]> {
  const db = await getDb();
  return (await repo.listKeys(db.sql)).map(infoOf);
}

/** Ключи для интерфейса администратора: только `managed=ui`. */
export async function uiKeys(): Promise<KeyInfo[]> {
  const db = await getDb();
  return (await repo.listKeys(db.sql)).filter((k) => k.managed === 'ui').map(infoOf);
}

/** Отозвать ключ по prefix. false — активного ключа с таким prefix нет. */
export async function revokeKey(actor: SystemActor, prefix: string): Promise<boolean> {
  if (!/^[a-z0-9]{8}$/.test(prefix)) throw new KeyInputError('prefix — 8 символов a-z, 0-9');
  const db = await getDb();
  return repo.revokeKeyRow(db.sql, prefix, actor.now);
}
