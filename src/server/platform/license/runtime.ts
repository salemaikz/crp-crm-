// Среда выполнения сборки клиента (D-312, D-314). Подпись лицензии проверяет живой node:crypto, поэтому предзагрузка
// (--require/--import/--loader в NODE_OPTIONS или аргументах node), инспектор (--inspect, сигнал SIGUSR1), чужая
// точка входа (скрипт из stdin или /tmp), переменные загрузчика (LD_PRELOAD, LD_AUDIT, OPENSSL_CONF…) и глобальные
// каталоги модулей node (HOME/.node_modules и др.) подменяют проверку без правки кода образа.
// Отказ запуска (выход с кодом 1, license.runtime_tamper) — только при явной подгрузке кода или отладке: флаги
// загрузчика и инспектора node, открытый инспектор, LD_PRELOAD/LD_AUDIT (runtimeRefusals). Остальное — сигнал
// (D-314): строка license.runtime_signal в журнале контейнера и запись в аудит при ближайшем пересчёте лицензии,
// запуск идёт. У таких признаков бывают честные причины (обёртка запуска, каталог в HOME, переменная в app.env),
// а нагрузка, написанная под проверку, их всё равно обходит: проверка идёт уже после чужого кода (ARCHITECTURE §8.4).
// Общая сборка (dev, CI, стенд, e2e с предзагрузкой ядра рабочей копии) не проверяется.
import { existsSync, realpathSync } from 'node:fs';
import inspector from 'node:inspector';
import Module from 'node:module';
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
  /** Существующие каталоги из Module.globalPaths (HOME/.node_modules, HOME/.node_libraries, <prefix>/lib/node,
   *  NODE_PATH): в образе их нет, а node ищет в них пакеты, которых нет в приложении. */
  globalModuleDirs: readonly string[];
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

/** Флаги node, которые явно подгружают код или открывают отладку: с ними сборка клиента не стартует (D-314). */
const REFUSED_FLAG = /^(-r|--require|--import|--loader|--experimental-loader|--inspect|--inspect-brk|--inspect-wait|--inspect-port|--debug|--debug-brk|--debug-port)$/;
/** Переменные загрузчика ОС, которые явно подгружают библиотеку в процесс: отказ запуска (D-314). */
const REFUSED_ENV = /^(LD_PRELOAD|LD_AUDIT)$/;

/** Замечание о запуске: код для аудита, текст для журнала (имена флагов и переменных, без путей и значений). */
export type RuntimeProblem = { code: string; text: string; refuse: boolean };

/** Что в запуске процесса сборки клиента не совпадает с поставкой (пусто — запуск как в поставке). */
export function runtimeProblems(f: RuntimeFacts): RuntimeProblem[] {
  if (!f.customerBuild) return [];
  const problems: RuntimeProblem[] = [];
  const fromOptions = nodeOptionTokens(f.env);
  const foreign = [...f.execArgv, ...fromOptions].filter((t) => !ALLOWED_FLAG.test(t));
  const refusedFlags = [...new Set(foreign.map(flagName).filter((n) => REFUSED_FLAG.test(n)))];
  if (refusedFlags.length > 0) {
    problems.push({ code: 'node_loader_flags', text: `флаги подгрузки кода или отладки node: ${refusedFlags.join(' ')}`, refuse: true });
  }
  const otherFlags = [...new Set(foreign.map(flagName).filter((n) => !REFUSED_FLAG.test(n) && n !== '<значение>'))];
  if (otherFlags.length > 0) {
    problems.push({ code: 'node_flags', text: `флаги node вне поставки (NODE_OPTIONS или команда): ${otherFlags.join(' ')}`, refuse: false });
  }
  if (!f.execArgv.includes(DISABLE_SIGUSR1) && !fromOptions.includes(DISABLE_SIGUSR1)) {
    problems.push({ code: 'no_disable_sigusr1', text: `node запущен без ${DISABLE_SIGUSR1}: инспектор открывается сигналом SIGUSR1`, refuse: false });
  }
  // Свой скрипт перед server.js (stdin, /tmp) подменяет node:crypto до загрузки приложения; путь не повторяем
  const entry = RUNTIME_ENTRY[f.role];
  if (f.entry !== entry || (f.mainModule !== undefined && f.mainModule !== entry)) {
    problems.push({ code: 'entry', text: `точка входа node не ${entry}: процесс запущен своим скриптом`, refuse: false });
  }
  const loaders = Object.keys(f.env)
    .filter((k) => CODE_LOADING_ENV.test(k) && (f.env[k] ?? '').trim() !== '')
    .sort();
  const refusedEnv = loaders.filter((k) => REFUSED_ENV.test(k));
  if (refusedEnv.length > 0) problems.push({ code: 'loader_preload', text: `заданы переменные подгрузки кода: ${refusedEnv.join(' ')}`, refuse: true });
  const otherEnv = loaders.filter((k) => !REFUSED_ENV.test(k));
  if (otherEnv.length > 0) problems.push({ code: 'loader_env', text: `заданы переменные подгрузки кода: ${otherEnv.join(' ')}`, refuse: false });
  if (f.inspectorUrl !== undefined) problems.push({ code: 'inspector_open', text: 'открыт инспектор node', refuse: true });
  if (f.globalModuleDirs.length > 0) {
    const kinds = [...new Set(f.globalModuleDirs.map(globalDirKind))].sort().join(' ');
    problems.push({ code: 'global_modules', text: `есть глобальный каталог модулей node: ${kinds}`, refuse: false });
  }
  return problems;
}

/** Все замечания текстом (журнал, тесты). */
export function runtimeTamperProblems(f: RuntimeFacts): string[] {
  return runtimeProblems(f).map((p) => p.text);
}

/** Замечания, с которыми сборка клиента не стартует: явная подгрузка кода или отладка (D-314). */
export function runtimeRefusals(f: RuntimeFacts): string[] {
  return runtimeProblems(f)
    .filter((p) => p.refuse)
    .map((p) => p.text);
}

/** Вид глобального каталога без пути: путь (HOME, том) в сообщение не попадает. */
function globalDirKind(dir: string): string {
  const d = dir.replace(/\/+$/, '');
  if (d.endsWith('/.node_modules')) return 'HOME/.node_modules';
  if (d.endsWith('/.node_libraries')) return 'HOME/.node_libraries';
  if (d.endsWith('/lib/node')) return 'prefix/lib/node';
  return 'NODE_PATH';
}

/** Каталоги, где node ищет пакеты сверх node_modules приложения; считаются при старте процесса (Module._initPaths). */
function existingGlobalModuleDirs(): string[] {
  // globalPaths нет в типах @types/node, но это открытое свойство модульного загрузчика CommonJS
  const paths = (Module as unknown as { globalPaths?: readonly string[] }).globalPaths ?? [];
  return paths.filter((p) => existsSync(p));
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
    globalModuleDirs: existingGlobalModuleDirs(),
  };
}

/** Строка тревоги для журнала процесса (stderr контейнера): отказ запуска. */
export function runtimeTamperMessage(problems: readonly string[]): string {
  return JSON.stringify({ level: 'error', code: 'license.runtime_tamper', problems });
}

/** Строка сигнала для журнала процесса: запуск идёт, но не как в поставке. */
export function runtimeSignalMessage(problems: readonly string[]): string {
  return JSON.stringify({ level: 'warn', code: 'license.runtime_signal', problems });
}

type SignalGlobal = typeof globalThis & { __crmRuntimeSignal?: { role: RuntimeRole; codes: string[] } | null };
const sg = globalThis as SignalGlobal;

/**
 * Проверка запуска процесса: отказы — вернуть вызывающему (он завершает процесс); сигналы — в журнал сразу и в аудит
 * при ближайшем пересчёте лицензии (service.ts, takeRuntimeSignal). Возвращает тексты отказов (пусто — запуск идёт).
 */
export function checkRuntime(role: RuntimeRole, facts: RuntimeFacts = currentRuntimeFacts(role)): string[] {
  const problems = runtimeProblems(facts);
  const refusals = problems.filter((p) => p.refuse).map((p) => p.text);
  if (refusals.length > 0) return refusals;
  if (problems.length > 0) {
    console.warn(runtimeSignalMessage(problems.map((p) => p.text)));
    sg.__crmRuntimeSignal = { role, codes: problems.map((p) => p.code) };
  }
  return [];
}

/** Сигнал запуска, ещё не записанный в аудит (один раз на процесс); null — нет. */
export function takeRuntimeSignal(): { role: RuntimeRole; codes: string[] } | null {
  const s = sg.__crmRuntimeSignal ?? null;
  sg.__crmRuntimeSignal = null;
  return s;
}

/** Вернуть сигнал, если запись в аудит не удалась (пересчёт откатился). */
export function restoreRuntimeSignal(s: { role: RuntimeRole; codes: string[] }): void {
  sg.__crmRuntimeSignal ??= s;
}
