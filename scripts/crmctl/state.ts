// Состояние установки на сервере: libDir/state.json (без секретов). project.env — переменные подстановки
// compose (CRM_VERSION), чтобы ручной `docker compose up` поднял ту же версию, что знает crmctl.
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CrmctlError, type Paths } from './types';

const stateSchema = z.object({
  installId: z.string().min(1),
  customer: z.string(),
  current: z.object({ version: z.string(), buildId: z.string(), switchedAt: z.number() }),
  previous: z.object({ version: z.string(), buildId: z.string() }).nullable(),
  hostPort: z.number().int().positive(),
});
export type State = z.infer<typeof stateSchema>;

export const stateFile = (p: Paths) => path.join(p.libDir, 'state.json');
export const projectEnvFile = (p: Paths) => path.join(p.etcDir, 'project.env');
export const composeFile = (p: Paths) => path.join(p.libDir, 'compose', 'compose.yaml');

export async function readState(p: Paths): Promise<State | null> {
  let raw: string;
  try {
    raw = await readFile(stateFile(p), 'utf8');
  } catch {
    return null;
  }
  const res = stateSchema.safeParse(JSON.parse(raw));
  if (!res.success) throw new CrmctlError(`${stateFile(p)} повреждён: ${res.error.issues[0]?.path.join('.')}`);
  return res.data;
}

export async function requireState(p: Paths): Promise<State> {
  const s = await readState(p);
  if (!s) throw new CrmctlError('Установка не найдена: сначала crmctl install');
  return s;
}

async function atomicWrite(file: string, body: string, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, body, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

export async function writeState(p: Paths, s: State): Promise<void> {
  await atomicWrite(stateFile(p), `${JSON.stringify(s, null, 2)}\n`, 0o644);
}

export async function writeProjectEnv(p: Paths, version: string, buildId: string, hostPort: number): Promise<void> {
  await atomicWrite(
    projectEnvFile(p),
    `CRM_VERSION=${version}\nCRM_BUILD_ID=${buildId}\nAPP_HOST_PORT=${hostPort}\n`,
    0o600,
  );
}
