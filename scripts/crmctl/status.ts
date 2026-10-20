// crmctl status — сводка установки; crmctl health — одна проверка /api/health (для cron и мониторинга:
// код выхода 0 здоров, 1 нет).
import { compose, describe } from './compose';
import { probeHost } from './health';
import { readState } from './state';
import { CrmctlError, type Deps } from './types';

export async function health(deps: Deps): Promise<number> {
  const s = await readState(deps.paths);
  if (!s) throw new CrmctlError('Установка не найдена');
  const h = await probeHost(deps, s.hostPort, s.current.version);
  deps.io.out(`${h.ok ? 'OK' : 'FAIL'} ${s.current.version}: ${h.detail}`);
  return h.ok ? 0 : 1;
}

export async function status(deps: Deps): Promise<number> {
  const s = await readState(deps.paths);
  if (!s) {
    deps.io.out('Не установлено.');
    return 1;
  }
  const { io } = deps;
  io.out(`Клиент:        ${s.customer}`);
  io.out(`installId:     ${s.installId}`);
  io.out(`Версия:        ${s.current.version} (сборка ${s.current.buildId})`);
  io.out(`Прежняя:       ${s.previous ? s.previous.version : '—'}`);
  const ps = await compose(deps, s.current.version, ['ps', '--format', 'table {{.Service}}\t{{.State}}\t{{.Health}}']);
  io.out(ps.code === 0 ? `Контейнеры:\n${ps.stdout.trim()}` : `Контейнеры: не получены (${describe(ps)})`);
  const h = await probeHost(deps, s.hostPort, s.current.version);
  io.out(`/api/health:   ${h.ok ? 'OK' : `FAIL (${h.detail})`}`);
  return h.ok ? 0 : 1;
}
