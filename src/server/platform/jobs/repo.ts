// SQL job_runs (дизайн worker-design §3). Вызывается под блокировкой задачи: сироты определяются ей.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { JOB_RETRY_BASE_MS, WORKER_HEARTBEAT_JOB } from './types';
import type { ClaimResult, JobRunRow, Ms, WorkerHeartbeat } from './types';

interface RunRow {
  id: string;
  job: string;
  slotKey: string;
  status: JobRunRow['status'];
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  stats: Record<string, number>;
  error: string;
}

/** Пауза перед повтором упавшей попытки: 60 с · 2^(attempt−1). */
export function retryDelayMs(attempt: number): number {
  return JOB_RETRY_BASE_MS * 2 ** (attempt - 1);
}

/** Захват слота одной транзакцией. Под блокировкой задачи любая `running` — упавший процесс. */
export async function claim(db: Db, runName: string, slotKey: string, now: Ms, maxAttempts: number): Promise<ClaimResult> {
  return db.tx(async (sql) => {
    await sql`UPDATE job_runs SET status = 'failed', finished_at = ${now}, error = 'orphaned' WHERE job = ${runName} AND status = 'running'`;
    const newId = randomUUID();
    const ins = await sql<{ id: string; attempt: number }>`
      INSERT INTO job_runs (id, job, slot_key, status, attempt, started_at)
      VALUES (${newId}, ${runName}, ${slotKey}, 'running', 1, ${now})
      ON CONFLICT (job, slot_key) DO NOTHING RETURNING id, attempt`;
    if (ins[0]) return { kind: 'claimed', runId: ins[0].id, attempt: ins[0].attempt };
    const [row] = await sql<{ id: string; status: string; attempt: number; finishedAt: number | null }>`
      SELECT id, status, attempt, finished_at FROM job_runs WHERE job = ${runName} AND slot_key = ${slotKey} FOR UPDATE`;
    if (!row || row.status !== 'failed' || row.attempt >= maxAttempts) return { kind: 'done' };
    const retryAt = (row.finishedAt ?? now) + retryDelayMs(row.attempt);
    if (retryAt > now) return { kind: 'backoff', retryAt };
    await sql`UPDATE job_runs SET status = 'running', attempt = attempt + 1, started_at = ${now}, finished_at = NULL, error = '' WHERE id = ${row.id}`;
    return { kind: 'claimed', runId: row.id, attempt: row.attempt + 1 };
  });
}

/** Итог попытки. `error` — код без ПДн. */
export async function finish(
  db: Db,
  runId: string,
  status: 'ok' | 'failed' | 'skipped',
  stats: Readonly<Record<string, number>>,
  error: string,
  now: Ms,
): Promise<void> {
  await db.sql`UPDATE job_runs SET status = ${status}, finished_at = ${now}, stats = ${db.json(stats)}, error = ${error} WHERE id = ${runId}`;
}

/** Пульс воркера: одна строка на установку, обновляется на каждом цикле. */
export async function beatHeartbeat(db: Db, hb: WorkerHeartbeat, now: Ms): Promise<void> {
  const stats = { startedAt: hb.startedAt, lastLoopAt: hb.lastLoopAt, jobs: hb.jobs };
  await db.sql`
    INSERT INTO job_runs (id, job, slot_key, status, attempt, started_at, finished_at, stats)
    VALUES (${randomUUID()}, ${WORKER_HEARTBEAT_JOB}, '-', 'ok', 1, ${hb.startedAt}, ${now}, ${db.json(stats)})
    ON CONFLICT (job, slot_key) DO UPDATE
      SET started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at, stats = EXCLUDED.stats`;
}

/** Последние прогоны (страница «Состояние», crmctl job list): по `limit` на задачу не режем, берём общим лимитом. */
export async function recentRuns(db: Db, limit = 100): Promise<JobRunRow[]> {
  const rows = await db.sql<RunRow>`
    SELECT id, job, slot_key, status, attempt, started_at, finished_at, stats, error
      FROM job_runs ORDER BY started_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ ...r }));
}
