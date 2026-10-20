// Главный цикл воркера (дизайн worker-design §4): задачи каждые 30 с, очереди каждые 5 с, пульс, остановка по сигналу.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { ActiveConfig } from '@crm/core/config';
import { systemActor } from '@/server/access/systemActor';
import { LOCKING_LICENSE_STATES } from '@/server/access/types';
import { currentLicenseState } from '@/server/access/license';
import { getDb } from '@/server/platform/db';
import { ConfigMissingError, getActiveConfig } from '@/server/platform/config/active';
import {
  beatHeartbeat,
  runInstance,
  runQueuePass,
  WORKER_ALIVE_FILE,
  WORKER_QUEUE_TICK_MS,
  WORKER_TICK_MS,
  type JobDefinition,
  type JobLogger,
  type Ms,
  type QueueSpec,
  type RunnerDeps,
} from '@/server/platform/jobs';
import { calendarFromConfig } from './calendar';
import { consoleJobLogger, makeRunnerDeps } from './deps';
import { instancesFor, jobDefinitions, queueSpecs } from './registry';

const STOP_WAIT_MS = 20_000;
const CONFIG_WARN_EVERY_MS = 60_000;

export interface WorkerOptions {
  defs?: () => JobDefinition[];
  queues?: () => QueueSpec[];
  deps?: RunnerDeps;
  log?: JobLogger;
  /** null — установка не настроена. */
  loadConfig?: () => Promise<ActiveConfig | null>;
  businessBlocked?: () => Promise<boolean>;
  aliveFile?: string | null;
  tickMs?: number;
  queueTickMs?: number;
}

export interface Worker {
  readonly bootId: string;
  /** Один цикл задач (для тестов и первого запуска). */
  runCycle(): Promise<void>;
  /** Один проход очередей. */
  runQueues(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

async function defaultLoadConfig(): Promise<ActiveConfig | null> {
  try {
    return await getActiveConfig();
  } catch (e) {
    if (e instanceof ConfigMissingError) return null;
    throw e;
  }
}

export function createWorker(opts: WorkerOptions = {}): Worker {
  const log = opts.log ?? consoleJobLogger;
  const deps = opts.deps ?? makeRunnerDeps(log);
  const defs = opts.defs ?? jobDefinitions;
  const queues = opts.queues ?? queueSpecs;
  const loadConfig = opts.loadConfig ?? defaultLoadConfig;
  const blocked = opts.businessBlocked ?? (async () => LOCKING_LICENSE_STATES.has(await currentLicenseState()));
  const aliveFile = opts.aliveFile === undefined ? WORKER_ALIVE_FILE : opts.aliveFile;
  const bootId = randomUUID();
  const startedAt = deps.clock();
  const stopper = new AbortController();
  let booted = false;
  let lastConfigWarn = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const inflight = new Set<Promise<unknown>>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.then(
      () => inflight.delete(p),
      () => inflight.delete(p),
    );
    return p;
  };

  async function runCycle(): Promise<void> {
    const now = deps.clock();
    let cfg: ActiveConfig | null = null;
    try {
      cfg = await loadConfig();
    } catch (e) {
      cfg = null;
      if (now - lastConfigWarn >= CONFIG_WARN_EVERY_MS) {
        lastConfigWarn = now;
        log.warn('config_invalid', { code: (e as { name?: string } | null)?.name ?? 'error' });
      }
    }
    let jobs = 0;
    if (!cfg) {
      if (now - lastConfigWarn >= CONFIG_WARN_EVERY_MS) {
        lastConfigWarn = now;
        log.warn('config_missing');
      }
    } else {
      const calendar = calendarFromConfig(cfg);
      const instances = instancesFor(defs(), cfg);
      jobs = instances.length;
      for (const inst of instances) {
        if (stopper.signal.aborted) break;
        try {
          if (!booted && inst.def.runOnStart) {
            await runInstance(deps, inst, { now, calendar, slot: { key: `boot:${bootId}`, at: now }, signal: stopper.signal });
          }
          await runInstance(deps, inst, { now: deps.clock(), calendar, signal: stopper.signal });
        } catch (e) {
          log.warn('instance_error', { job: inst.runName, code: (e as { name?: string } | null)?.name ?? 'error' });
        }
      }
      booted = true;
    }
    try {
      await beatHeartbeat(await getDb(), { startedAt, lastLoopAt: deps.clock(), jobs }, deps.clock());
    } catch (e) {
      log.warn('heartbeat_error', { code: (e as { name?: string } | null)?.name ?? 'error' });
    }
    if (aliveFile) await writeFile(aliveFile, String(deps.clock())).catch(() => {});
  }

  async function runQueues(): Promise<void> {
    const db = await getDb();
    let isBlocked: boolean | null = null;
    for (const spec of queues()) {
      if (stopper.signal.aborted) break;
      if (!spec.enabled()) continue;
      try {
        if (spec.writes === 'business') {
          isBlocked ??= await blocked();
          if (isBlocked) continue;
        }
        const s = await runQueuePass(db, spec, { actor: systemActor(spec.name, deps.clock()), now: deps.clock, signal: stopper.signal, log });
        if (s.taken > 0) log.info('queue_pass', { queue: spec.name, ...s });
      } catch (e) {
        log.warn('queue_error', { queue: spec.name, code: (e as { name?: string } | null)?.name ?? 'error' });
      }
    }
  }

  const loop = (fn: () => Promise<void>, every: Ms): void => {
    const step = (): void => {
      if (stopper.signal.aborted) return;
      void track(fn()).catch(() => {}).finally(() => {
        if (stopper.signal.aborted) return;
        const t = setTimeout(step, every);
        timers.push(t);
      });
    };
    step();
  };

  return {
    bootId,
    runCycle,
    runQueues,
    start() {
      loop(runCycle, opts.tickMs ?? WORKER_TICK_MS);
      loop(runQueues, opts.queueTickMs ?? WORKER_QUEUE_TICK_MS);
    },
    async stop() {
      stopper.abort();
      for (const t of timers) clearTimeout(t);
      timers = [];
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise<void>((r) => {
          waitTimer = setTimeout(r, STOP_WAIT_MS);
        }),
      ]);
      if (waitTimer) clearTimeout(waitTimer);
    },
  };
}
