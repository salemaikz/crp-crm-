// crmctl ingest-key: create, list, revoke (INTEGRATIONS 5.1). Коды выхода: 0 — успех; 1 — ошибка или неверные аргументы.
// Ключ печатается один раз при создании; в БД — только sha256 секрета. Ключи `managed=cli` в интерфейсе CRM не видны.
// Запуск до реестра crmctl: tsx scripts/crmctl/ingest.ts <подкоманда> …
import { pathToFileURL } from 'node:url';
import { createKey, KeyInputError, listKeys, parseScopes, revokeKey } from '../../src/server/domain/intake';
import { systemActor } from '../../src/server/access/systemActor';
import { openScriptDb } from '../../src/server/platform/db';

export type IngestIo = { out: (line: string) => void; err: (line: string) => void };

export type IngestCtx = {
  io: IngestIo;
  /** Открыть БД и вернуть закрытие. По умолчанию — openScriptDb (DATABASE_URL). */
  openDb: () => Promise<() => Promise<void>>;
  now: () => number;
};

const USAGE = `Использование: crmctl ingest-key <подкоманда>
  create --space <ключ> --source <ключ> [--scopes leads:write,leads:demand] [--managed cli|ui]
                          выдать ключ (показывается один раз)
  list                    ключи без секретов
  revoke <prefix>         отозвать ключ`;

class UsageError extends Error {
  override name = 'UsageError';
}

const VALUE_FLAGS = ['space', 'source', 'scopes', 'managed'];

function parseArgs(argv: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!VALUE_FLAGS.includes(name)) throw new UsageError(`неизвестный флаг --${name}`);
    const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`флагу --${name} нужно значение`);
    flags.set(name, value);
  }
  return { positional, flags };
}

const defaultCtx = (): IngestCtx => ({
  io: { out: (l) => console.log(l), err: (l) => console.error(l) },
  openDb: openScriptDb,
  now: () => Date.now(),
});

const stamp = (ms: number | null): string => (ms === null ? '-' : new Date(ms).toISOString());

export async function runIngestKey(argv: string[], ctx: IngestCtx = defaultCtx()): Promise<number> {
  const { io } = ctx;
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    io.out(USAGE);
    return sub ? 0 : 1;
  }
  let close: (() => Promise<void>) | null = null;
  try {
    if (!['create', 'list', 'revoke'].includes(sub)) throw new UsageError(`неизвестная подкоманда «${sub}»`);
    const p = parseArgs(rest);
    const actor = systemActor('crmctl.ingest-key', ctx.now());
    if (sub === 'create') {
      const space = p.flags.get('space');
      const source = p.flags.get('source');
      if (!space || !source) throw new UsageError('нужны --space и --source');
      const managed = p.flags.get('managed') ?? 'cli';
      if (managed !== 'cli' && managed !== 'ui') throw new UsageError('--managed: cli или ui');
      const scopes = parseScopes(p.flags.get('scopes') ?? 'leads:write,leads:demand');
      close = await ctx.openDb();
      const { key, info } = await createKey(actor, { spaceKey: space, sourceKey: source, scopes, managed });
      io.out(`Ключ создан: prefix ${info.prefix}, источник ${info.sourceKey}, пространство ${info.spaceKey}, разрешения ${info.scopes.join(',')}, managed=${info.managed}`);
      io.out('Ключ показывается один раз, в базе его нет — сохраните сейчас:');
      io.out(key);
      return 0;
    }
    if (sub === 'list') {
      close = await ctx.openDb();
      const keys = await listKeys(actor);
      if (keys.length === 0) io.out('Ключей нет');
      for (const k of keys) {
        io.out(
          [k.prefix, k.sourceKey, k.spaceKey, k.scopes.join(','), `managed=${k.managed}`, `создан ${stamp(k.createdAt)}`, `использован ${stamp(k.lastUsedAt)}`, k.revokedAt ? `отозван ${stamp(k.revokedAt)}` : 'активен'].join('\t'),
        );
      }
      return 0;
    }
    const prefix = p.positional[0];
    if (!prefix || p.positional.length !== 1) throw new UsageError('нужен prefix ключа');
    close = await ctx.openDb();
    if (!(await revokeKey(actor, prefix))) {
      io.err(`Активного ключа с prefix ${prefix} нет`);
      return 1;
    }
    io.out(`Ключ ${prefix} отозван`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 1;
    }
    if (e instanceof KeyInputError) {
      io.err(e.message);
      return 1;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    if (close) await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestKey(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
