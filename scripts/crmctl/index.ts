// crmctl: единая команда сопровождения установки. Собирается в dist/crmctl.mjs (Dockerfile, esbuild) и
// запускается на хосте под sudo (учётка crmops, D-027). Реестр команд ведёт ops; команду пишет поток
// своего модуля (PLAN §2): scripts/crmctl/<команда>.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParsedArgs } from './args';
import { realExecutor } from './exec';
import { install } from './install';
import { rollback } from './rollback';
import { health, status } from './status';
import { CrmctlError, type Deps } from './types';
import { update } from './update';
import { stubVerifier } from './verify';
import { runConfig } from './config';
import { backupMain } from './backup';
import { restoreMain } from './restore';
import { runIngestKey } from './ingest';
import { runJob } from './job';
import { runSeedCommand } from './seed';

type Command = (deps: Deps, args: ParsedArgs) => Promise<number>;

/**
 * Реестр команд. Место для `config` (P5: apply/diff/rollback настроек), `license` (P10),
 * `ingest-key` (C3), `secrets` (O5): каждая добавляет строку сюда и свой файл рядом.
 */
export const commands: Record<string, Command> = {
  install,
  update,
  rollback,
  status: (deps) => status(deps),
  health: (deps) => health(deps),
};

/**
 * Команды со своим разбором аргументов: получают argv без имени команды и сами печатают справку.
 * config — настройки (P5), backup/restore — копии и восстановление (O3).
 */
export const rawCommands: Record<string, (argv: string[]) => Promise<number>> = {
  config: runConfig,
  backup: (argv) => backupMain(argv),
  restore: (argv) => restoreMain(argv),
  'ingest-key': runIngestKey,
  seed: runSeedCommand,
  job: runJob,
};

export const USAGE = `crmctl — сопровождение установки CRM

  install <пакет> --domain <хост> --admin-phone <номер> --admin-name <имя>
                  [--invite-ttl-hours 72] [--host-port 3100]
  update <пакет>  [--wait-seconds 90] [--recheck-seconds 120]
  rollback        [--wait-seconds 90]
  status
  health          код выхода 0 — приложение здорово
  config …        настройки и пресеты (crmctl config --help)
  backup …        копии БД (crmctl backup --help)
  restore …       восстановление копии (crmctl restore --help)
  ingest-key …    ключи источников лидов: create | list | revoke
  seed …          синтетические данные для стенда (crmctl seed --help)
  job …           фоновые задачи: list | run <имя> [--space <ключ>] [--slot <ключ>]

Пакет — каталог или .tar.zst. Переменные: CRM_ETC_DIR, CRM_LIB_DIR, CRM_CLI_DIR, CRM_BACKUP_CMD.`;

export function defaultDeps(env: Record<string, string | undefined> = process.env): Deps {
  return {
    exec: realExecutor,
    io: { out: (l) => console.log(l), err: (l) => console.error(l) },
    env,
    paths: {
      etcDir: env.CRM_ETC_DIR ?? '/etc/crm',
      libDir: env.CRM_LIB_DIR ?? '/var/lib/crm',
      backupCmd: env.CRM_BACKUP_CMD ?? '/usr/local/lib/crm/backup.sh',
      cliDir: env.CRM_CLI_DIR ?? '/usr/local/lib/crm',
    },
    verifier: stubVerifier(env),
    http: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { status: res.status, body: await res.text() };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    randomBytes: (n) => randomBytes(n),
    randomUuid: () => randomUUID(),
  };
}

/** Точка входа для тестов и main: возвращает код выхода, не завершает процесс. */
export async function run(argv: string[], deps: Deps = defaultDeps()): Promise<number> {
  try {
    const raw = argv[0] ? rawCommands[argv[0]] : undefined;
    if (raw) return await raw(argv.slice(1));
    const args = parseArgs(argv);
    if (!args.command || args.command === 'help' || args.flags.help) {
      deps.io.out(USAGE);
      return args.command ? 0 : 2;
    }
    const cmd = commands[args.command];
    if (!cmd) {
      deps.io.err(`Неизвестная команда: ${args.command}\n\n${USAGE}`);
      return 2;
    }
    return await cmd(deps, args);
  } catch (e) {
    if (e instanceof CrmctlError) {
      deps.io.err(e.message);
      return e.exitCode;
    }
    deps.io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

// Запуск как программы (dist/crmctl.mjs или tsx scripts/crmctl/index.ts); при импорте из тестов не стартует
const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? safeReal(process.argv[1]) : '';
function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
if (entry === self) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
