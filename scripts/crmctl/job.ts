// crmctl job list | run <имя> [--space <ключ>] [--slot <ключ>] — ручной запуск фоновых задач (worker-design §1).
// Регистрация в реестре команд scripts/crmctl/index.ts — на стороне ops (rawCommands.job = runJob).
// Прогон идёт под той же блокировкой и в тот же job_runs, что и у воркера: параллельный запуск пропускается.
import { randomUUID } from 'node:crypto';
import { calendarFromConfig } from '../../src/server/jobs/calendar';
import { makeRunnerDeps } from '../../src/server/jobs/deps';
import { instancesFor, jobDefinitions } from '../../src/server/jobs/registry';
import { getActiveConfig } from '../../src/server/platform/config/active';
import { getDb, openScriptDb } from '../../src/server/platform/db';
import { recentRuns, runInstance } from '../../src/server/platform/jobs';

const USAGE = 'crmctl job list\ncrmctl job run <имя> [--space <ключ>] [--slot <ключ>]';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runJob(argv: string[]): Promise<number> {
  const [sub, name] = argv;
  if (sub !== 'list' && !(sub === 'run' && name)) {
    console.error(USAGE);
    return 2;
  }
  const close = await openScriptDb();
  try {
    if (sub === 'list') {
      for (const r of await recentRuns(await getDb(), 50)) {
        console.log(`${r.job}\t${r.slotKey}\t${r.status}\t#${r.attempt}\t${r.error}`);
      }
      return 0;
    }
    const cfg = await getActiveConfig();
    const spaceKey = flag(argv, '--space');
    const found = instancesFor(jobDefinitions(), cfg).filter((i) => i.def.name === name && (!i.space || !spaceKey || i.space.key === spaceKey));
    if (found.length === 0) {
      console.error('нет такой задачи (для задач по пространствам укажите --space)');
      return 2;
    }
    const calendar = calendarFromConfig(cfg);
    const deps = makeRunnerDeps();
    let code = 0;
    for (const inst of found) {
      const now = Date.now();
      const slot = { key: flag(argv, '--slot') ?? `manual:${randomUUID()}`, at: now };
      const out = await runInstance(deps, inst, { now, calendar, slot });
      console.log(`${inst.runName}: ${out.kind === 'ran' ? out.status : out.kind}`);
      if (out.kind === 'ran' && out.status === 'failed') code = 1;
    }
    return code;
  } finally {
    await close();
  }
}
