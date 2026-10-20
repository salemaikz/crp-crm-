// crmctl seed: синтетические данные для учебного стенда и e2e (PLAN O8b). Коды выхода: 0 — успех; 1 — ошибка или отказ.
// Не для боевой установки: при NODE_ENV=production нужен флаг --i-know-this-is-a-stand.
// Пароли созданных сотрудников печатаются один раз; задать общий пароль можно переменной CRM_SEED_PASSWORD.
// Запуск: crmctl seed [флаги] или tsx scripts/crmctl/seed.ts [флаги]
import { pathToFileURL } from 'node:url';
import { openScriptDb } from '../../src/server/platform/db';
import { PASSWORD_ENV, runSeed, SeedRefusedError, STAND_FLAG, type SeedOptions } from '../seed';

export type SeedIo = { out: (line: string) => void; err: (line: string) => void };

export type SeedCtx = {
  io: SeedIo;
  /** Открыть БД и вернуть закрытие. По умолчанию — openScriptDb (DATABASE_URL). */
  openDb: () => Promise<() => Promise<void>>;
  env: Record<string, string | undefined>;
  now: () => number;
};

const USAGE = `Использование: crmctl seed [--seed <зерно>] [--clients 500] [--operators 5] [--layers a,b,…] [${STAND_FLAG}]
  Загружает пресет и синтетику: сотрудники, 500 клиентов с карточками, мероприятия, сделки, задачи.
  Повторный запуск ничего не дублирует. При NODE_ENV=production без ${STAND_FLAG} отказывает.
  ${PASSWORD_ENV} — общий пароль всех учёток стенда; без него пароли генерируются и печатаются один раз.`;

class UsageError extends Error {
  override name = 'UsageError';
}

const VALUE_FLAGS = ['seed', 'clients', 'operators', 'layers'];

export function parseSeedArgs(argv: readonly string[]): { opts: Pick<SeedOptions, 'seed' | 'clients' | 'operators' | 'layers' | 'standFlag'>; help: boolean } {
  const opts: Pick<SeedOptions, 'seed' | 'clients' | 'operators' | 'layers' | 'standFlag'> = {};
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--help' || a === '-h') {
      help = true;
      continue;
    }
    if (!a.startsWith('--')) throw new UsageError(`лишний аргумент «${a}»`);
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (name === STAND_FLAG.slice(2)) {
      opts.standFlag = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(name)) throw new UsageError(`неизвестный флаг --${name}`);
    const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`флагу --${name} нужно значение`);
    if (name === 'seed') opts.seed = value;
    else if (name === 'layers') opts.layers = value.split(',').map((s) => s.trim()).filter(Boolean);
    else {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new UsageError(`--${name}: нужно целое число`);
      if (name === 'clients') opts.clients = n;
      else opts.operators = n;
    }
  }
  return { opts, help };
}

const defaultCtx = (): SeedCtx => ({
  io: { out: (l) => console.log(l), err: (l) => console.error(l) },
  openDb: openScriptDb,
  env: process.env,
  now: () => Date.now(),
});

export async function runSeedCommand(argv: string[], ctx: SeedCtx = defaultCtx()): Promise<number> {
  const { io } = ctx;
  let close: (() => Promise<void>) | null = null;
  try {
    const { opts, help } = parseSeedArgs(argv);
    if (help) {
      io.out(USAGE);
      return 0;
    }
    // Отказ для production — до открытия БД
    if (ctx.env.NODE_ENV === 'production' && opts.standFlag !== true) {
      throw new SeedRefusedError(`NODE_ENV=production: сид с синтетикой запрещён. Если это учебный стенд, добавьте ${STAND_FLAG}.`);
    }
    close = await ctx.openDb();
    const r = await runSeed({ ...opts, env: ctx.env, now: ctx.now() });
    io.out(`Пресет: ${r.config === 'applied' ? 'записан' : 'без изменений'}`);
    const lines = Object.entries(r.inserted).filter(([, n]) => n > 0);
    if (lines.length === 0) io.out('Данные: без изменений');
    for (const [table, n] of lines) io.out(`  ${table}: +${n}`);
    if (r.accounts.length > 0) {
      io.out('Учётные записи созданы (вход по номеру телефона):');
      for (const a of r.accounts) io.out(`  ${a.role.padEnd(15)} +${a.phone}  ${a.name}${a.password ? `  пароль: ${a.password}` : ''}`);
      if (r.accounts.some((a) => a.password)) io.out('Пароли показаны один раз и нигде не сохранены — запишите их сейчас.');
      else io.out(`Пароль у всех — из ${PASSWORD_ENV}.`);
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 1;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    if (close) await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeedCommand(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
