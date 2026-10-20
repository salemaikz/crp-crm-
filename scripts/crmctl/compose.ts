// Обёртка над `docker compose` проекта crm. Версия образа передаётся переменной CRM_VERSION
// (поверх project.env), поэтому один и тот же compose.yaml поднимает любую загруженную версию.
import { composeFile, projectEnvFile } from './state';
import { CrmctlError, type Deps, type RunResult } from './types';

export const CANDIDATE_NAME = 'crm-app-next';

export function composeArgs(deps: Deps, ...rest: string[]): string[] {
  return ['compose', '-p', 'crm', '-f', composeFile(deps.paths), '--env-file', projectEnvFile(deps.paths), ...rest];
}

export function describe(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `код ${r.code}`).split('\n').slice(-6).join('\n');
}

/** Команда compose с заданной версией образа. */
export function compose(deps: Deps, version: string, args: string[], input?: string): Promise<RunResult> {
  return deps.exec.run('docker', composeArgs(deps, ...args), { env: { CRM_VERSION: version }, input });
}

export async function mustCompose(deps: Deps, version: string, what: string, args: string[]): Promise<RunResult> {
  const r = await compose(deps, version, args);
  if (r.code !== 0) throw new CrmctlError(`${what}: ${describe(r)}`);
  return r;
}

/** psql в контейнере db под crm_owner. SQL идёт на stdin: пароли и ПДн не попадают в argv. */
export function psql(deps: Deps, version: string, sql: string): Promise<RunResult> {
  return compose(
    deps,
    version,
    ['exec', '-T', 'db', 'psql', '-U', 'crm_owner', '-d', 'crm', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'],
    sql,
  );
}

/** Строковый литерал SQL. Только для значений, прошедших проверку; NUL недопустим. */
export function sqlLit(v: string): string {
  if (v.includes('\0')) throw new CrmctlError('Недопустимый символ в значении');
  return `'${v.replace(/'/g, "''")}'`;
}
