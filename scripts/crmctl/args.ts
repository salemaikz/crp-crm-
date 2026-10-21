// Разбор аргументов командной строки crmctl: `crmctl <команда> [позиционные] [--флаг[=значение]]`.
import { CrmctlError } from './types';

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Флаги, у которых есть значение; остальные — логические. */
const VALUE_FLAGS = new Set([
  'domain',
  'admin-phone',
  'admin-name',
  'invite-ttl-hours',
  'recheck-seconds',
  'host-port',
  'wait-seconds',
  'sig',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (!name) throw new CrmctlError(`Пустое имя флага: ${a}`, 2);
    if (VALUE_FLAGS.has(name)) {
      let value: string | undefined;
      if (eq !== -1) value = a.slice(eq + 1);
      else {
        value = rest[i + 1];
        i++;
      }
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        throw new CrmctlError(`Флагу --${name} нужно значение`, 2);
      }
      flags[name] = value;
    } else {
      if (eq !== -1) throw new CrmctlError(`Флаг --${name} не принимает значение`, 2);
      flags[name] = true;
    }
  }
  return { command, positional, flags };
}

/** Целое положительное из флага или умолчание. */
export function intFlag(flags: ParsedArgs['flags'], name: string, def: number): number {
  const v = flags[name];
  if (v === undefined) return def;
  if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) <= 0) {
    throw new CrmctlError(`--${name}: нужно целое положительное число`, 2);
  }
  return Number(v);
}

/** Строковый флаг (обязательный, если def не задан). */
export function strFlag(flags: ParsedArgs['flags'], name: string, def?: string): string {
  const v = flags[name];
  if (typeof v === 'string') return v;
  if (def !== undefined) return def;
  throw new CrmctlError(`Нужен флаг --${name}`, 2);
}
