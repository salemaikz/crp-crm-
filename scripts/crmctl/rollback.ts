// crmctl rollback: вернуть прежнюю версию образа (DEPLOY §5.2). БД не откатывается: миграции только
// добавляющие, прежняя версия читает новую схему (D-060).
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { intFlag, type ParsedArgs } from './args';
import { isDirectory } from './manifest';
import { imageExists, syncCli } from './images';
import { restoreVersion } from './update';
import { composeFile, requireState, type State } from './state';
import { CrmctlError, type Deps } from './types';

export async function rollback(deps: Deps, args: ParsedArgs): Promise<number> {
  const waitMs = intFlag(args.flags, 'wait-seconds', 90) * 1000;
  const state = await requireState(deps.paths);
  if (!state.previous) throw new CrmctlError('Откатываться некуда: прежняя версия не записана');
  const target = state.previous;
  if (!(await imageExists(deps, `crm-app:${target.version}`))) {
    throw new CrmctlError(`Образа crm-app:${target.version} нет на сервере (почищен?). Загрузите пакет через crmctl update`);
  }
  deps.io.out(`Откат ${state.current.version} -> ${target.version}`);
  deps.io.out('Внимание: правки настроек, сделанные версией ' + state.current.version + ', после отката не видны (D-060).');
  const next: State = {
    ...state,
    current: { version: target.version, buildId: target.buildId, switchedAt: deps.now() },
    previous: { version: state.current.version, buildId: state.current.buildId },
  };
  // Меняем местами compose и compose.prev: повторный rollback вернёт файлы обратно
  const cur = path.dirname(composeFile(deps.paths));
  const prev = path.join(deps.paths.libDir, 'compose.prev');
  const tmp = path.join(deps.paths.libDir, 'compose.swap');
  if (await isDirectory(prev)) {
    await rm(tmp, { recursive: true, force: true });
    await rename(cur, tmp);
    await rename(prev, cur);
    await rename(tmp, prev);
  }
  const ok = await restoreVersion(deps, next, waitMs, false);
  if (!ok) {
    deps.io.err(`Версия ${target.version} не отвечает на /api/health. Нужно вмешательство: docker compose -p crm logs app`);
    return 2;
  }
  await syncCli(deps, target.version);
  deps.io.out(`Работает ${target.version}.`);
  return 0;
}
