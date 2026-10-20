// Проверки живости: приложение на хосте (127.0.0.1:порт) и кандидат внутри сети до переключения.
import { CANDIDATE_NAME } from './compose';
import type { Deps } from './types';

export interface HealthResult {
  ok: boolean;
  detail: string;
}

/**
 * Разбор ответа /api/health. Контракт ответа ведёт платформа; здесь нужно одно: HTTP 200 и, если в теле
 * есть `version`, она совпадает с ожидаемой (иначе отвечает прежняя версия, а не новая).
 */
export function judgeHealth(status: number, body: string, expectedVersion?: string): HealthResult {
  if (status !== 200) return { ok: false, detail: `HTTP ${status}` };
  if (!expectedVersion) return { ok: true, detail: 'ok' };
  try {
    const v = (JSON.parse(body) as { version?: unknown }).version;
    if (typeof v === 'string' && v !== expectedVersion) return { ok: false, detail: `версия ${v}, ожидалась ${expectedVersion}` };
  } catch {
    // тело не JSON: версию не сверяем
  }
  return { ok: true, detail: 'ok' };
}

export async function probeHost(deps: Deps, port: number, expectedVersion?: string): Promise<HealthResult> {
  try {
    const r = await deps.http(`http://127.0.0.1:${port}/api/health`);
    return judgeHealth(r.status, r.body, expectedVersion);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'нет ответа' };
  }
}

/** Кандидат: запрос изнутри контейнера (порт наружу не публикуется). */
export async function probeCandidate(deps: Deps, expectedVersion: string): Promise<HealthResult> {
  const script =
    "fetch('http://127.0.0.1:3000/api/health').then(async r=>{console.log(JSON.stringify({status:r.status,body:await r.text()}));process.exit(0)},()=>process.exit(2))";
  const r = await deps.exec.run('docker', ['exec', CANDIDATE_NAME, 'node', '-e', script]);
  if (r.code !== 0) return { ok: false, detail: 'нет ответа' };
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { status: number; body: string };
    return judgeHealth(j.status, j.body, expectedVersion);
  } catch {
    return { ok: false, detail: 'ответ не разобран' };
  }
}

/** Ждать здоровья до `waitMs` с шагом 2 с. */
export async function waitHealthy(deps: Deps, probe: () => Promise<HealthResult>, waitMs: number): Promise<HealthResult> {
  const step = 2000;
  let last: HealthResult = { ok: false, detail: 'не проверялось' };
  for (let spent = 0; ; spent += step) {
    last = await probe();
    if (last.ok || spent >= waitMs) return last;
    await deps.sleep(step);
  }
}
