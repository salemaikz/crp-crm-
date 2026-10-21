// Среда выполнения сборки клиента (D-312). Подпись лицензии проверяет живой node:crypto, поэтому предзагрузка
// (--require/--import/--loader в NODE_OPTIONS или аргументах node), инспектор (--inspect, сигнал SIGUSR1) и
// LD_PRELOAD подменяют проверку без правки кода. Сборка клиента такой процесс не запускает: приложение
// (src/instrumentation.ts) и воркер (scripts/worker/run.ts) выходят с кодом 1 и тревогой license.runtime_tamper.
// Это планка, а не защита от root: предзагрузка, написанная под эту проверку, её обходит (ARCHITECTURE §8.4).
// Общая сборка (dev, CI, стенд, e2e с предзагрузкой ядра рабочей копии) не проверяется.
import inspector from 'node:inspector';
import type { Env } from '../env';
import { licenseEnv } from './env';

export type RuntimeFacts = {
  /** Сборка с водяным знаком клиента (watermark.customer задан). */
  customerBuild: boolean;
  /** Флаги node до имени скрипта (process.execArgv). */
  execArgv: readonly string[];
  env: Env;
  /** Адрес открытого инспектора (inspector.url()); undefined — закрыт. */
  inspectorUrl: string | undefined;
};

/** Белый список флагов node в поставке: память и запрет инспектора по сигналу. Остальное — только новым выпуском. */
const ALLOWED_FLAG = /^(--disable-sigusr1|--max-old-space-size=\d{1,6})$/;
const DISABLE_SIGUSR1 = '--disable-sigusr1';

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
  if ((f.env.LD_PRELOAD ?? '').trim() !== '') problems.push('задан LD_PRELOAD');
  if (f.inspectorUrl !== undefined) problems.push('открыт инспектор node');
  return problems;
}

/** Факты этого процесса; водяной знак — из окружения проверки лицензии (в тестах подменяется, testing.ts). */
export function currentRuntimeFacts(): RuntimeFacts {
  return {
    customerBuild: licenseEnv().watermark.customer !== null,
    execArgv: process.execArgv,
    env: process.env,
    inspectorUrl: inspector.url(),
  };
}

/** Строка тревоги для журнала процесса (stderr контейнера). */
export function runtimeTamperMessage(problems: readonly string[]): string {
  return JSON.stringify({ level: 'error', code: 'license.runtime_tamper', problems });
}
