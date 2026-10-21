// Среда выполнения сборки клиента (D-312). Подпись лицензии проверяет живой node:crypto, поэтому предзагрузка
// (--require/--import/--loader в NODE_OPTIONS или аргументах node), инспектор (--inspect, сигнал SIGUSR1), чужая
// точка входа (скрипт из stdin или /tmp, который подменяет проверку и потом грузит server.js) и переменные загрузчика
// (LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH, OPENSSL_CONF…) подменяют проверку без правки кода образа. Сборка клиента
// такой процесс не запускает: приложение (src/instrumentation.ts) и воркер (scripts/worker/run.ts) выходят с кодом 1
// и тревогой license.runtime_tamper. Это планка, а не защита от root: обёртка, которая подделывает process.argv,
// execArgv и inspector под эту проверку, её обходит (ARCHITECTURE §8.4).
// Общая сборка (dev, CI, стенд, e2e с предзагрузкой ядра рабочей копии) не проверяется.
import { realpathSync } from 'node:fs';
import inspector from 'node:inspector';
import type { Env } from '../env';
import { licenseEnv } from './env';

export type RuntimeRole = 'app' | 'worker';

/** Точки входа поставки (Dockerfile, deploy/compose/compose.yaml): node запускает ровно этот файл образа. */
export const RUNTIME_ENTRY: Readonly<Record<RuntimeRole, string>> = { app: '/app/server.js', worker: '/app/dist/worker.mjs' };

export type RuntimeFacts = {
  /** Сборка с водяным знаком клиента (watermark.customer задан). */
  customerBuild: boolean;
  /** Какой процесс поставки проверяется. */
  role: RuntimeRole;
  /** Скрипт, который запустил node (realpath(process.argv[1])); '-' или undefined — stdin, -e, REPL. */
  entry: string | undefined;
  /** Главный модуль CommonJS (process.mainModule.filename); у ESM-входа его нет. */
  mainModule: string | undefined;
  /** Флаги node до имени скрипта (process.execArgv). */
  execArgv: readonly string[];
  env: Env;
  /** Адрес открытого инспектора (inspector.url()); undefined — закрыт. */
  inspectorUrl: string | undefined;
};

/** Белый список флагов node в поставке: память и запрет инспектора по сигналу. Остальное — только новым выпуском. */
const ALLOWED_FLAG = /^(--disable-sigusr1|--max-old-space-size=\d{1,6})$/;
const DISABLE_SIGUSR1 = '--disable-sigusr1';
/** Переменные, которыми загрузчик ОС, OpenSSL или node подгружают чужой код в процесс. В поставке их нет. */
const CODE_LOADING_ENV = /^(LD_[A-Z0-9_]+|GCONV_PATH|NODE_PATH|NODE_COMPILE_CACHE|OPENSSL_CONF|OPENSSL_MODULES|OPENSSL_ENGINES)$/;

/** Имя флага без значения: путь к подгружаемому файлу в сообщение не попадает. */
function flagName(token: string): string {
  if (!token.startsWith('-')) return '<значение>';
  return token.split('=')[0]!.slice(0, 40);
}

function nodeOptionTokens(env: Env): string[] {
  const raw = env.NODE_OPTIONS ?? '';
  return raw.split(/\s+/).filter((t) => t !== '');
}

/** Что в запуске процесса сборки клиента не совпадает с поставкой (пусто — запуск как в поставке). */
export function runtimeTamperProblems(f: RuntimeFacts): string[] {
  if (!f.customerBuild) return [];
  const problems: string[] = [];
  const fromOptions = nodeOptionTokens(f.env);
  const foreign = [...f.execArgv, ...fromOptions].filter((t) => !ALLOWED_FLAG.test(t));
  if (foreign.length > 0) {
    const names = [...new Set(foreign.map(flagName))].join(' ');
    problems.push(`флаги node вне поставки (NODE_OPTIONS или команда): ${names}`);
  }
  if (!f.execArgv.includes(DISABLE_SIGUSR1) && !fromOptions.includes(DISABLE_SIGUSR1)) {
    problems.push(`node запущен без ${DISABLE_SIGUSR1}: инспектор открывается сигналом SIGUSR1`);
  }
  // Свой скрипт перед server.js (stdin, /tmp) подменяет node:crypto до загрузки приложения; путь не повторяем
  const entry = RUNTIME_ENTRY[f.role];
  if (f.entry !== entry || (f.mainModule !== undefined && f.mainModule !== entry)) {
    problems.push(`точка входа node не ${entry}: процесс запущен своим скриптом`);
  }
  const loaders = Object.keys(f.env)
    .filter((k) => CODE_LOADING_ENV.test(k) && (f.env[k] ?? '').trim() !== '')
    .sort();
  if (loaders.length > 0) problems.push(`заданы переменные подгрузки кода: ${loaders.join(' ')}`);
  if (f.inspectorUrl !== undefined) problems.push('открыт инспектор node');
  return problems;
}

/** realpath скрипта: ссылка на server.js из другого места — тот же файл образа, а не чужой вход. */
function realEntry(arg: string | undefined): string | undefined {
  if (arg === undefined || arg === '' || arg === '-') return arg;
  try {
    return realpathSync(arg);
  } catch {
    return arg;
  }
}

/** Факты этого процесса; водяной знак — из окружения проверки лицензии (в тестах подменяется, testing.ts). */
export function currentRuntimeFacts(role: RuntimeRole): RuntimeFacts {
  return {
    customerBuild: licenseEnv().watermark.customer !== null,
    role,
    entry: realEntry(process.argv[1]),
    // process.mainModule устарел только в документации (DEP0138) и есть у входа CommonJS — server.js
    mainModule: process.mainModule?.filename,
    execArgv: process.execArgv,
    env: process.env,
    inspectorUrl: inspector.url(),
  };
}

/** Строка тревоги для журнала процесса (stderr контейнера). */
export function runtimeTamperMessage(problems: readonly string[]): string {
  return JSON.stringify({ level: 'error', code: 'license.runtime_tamper', problems });
}
