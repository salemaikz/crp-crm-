// CSP frame-src для окна чата Wazzup (дизайн docs/reports-plugins-design.md §8.8, D-270). По умолчанию окна
// сторонних сайтов закрыты (`frame-src 'none'`). Домен Wazzup дописывается файлом /etc/crm/nginx-csp.d/frame.conf
// ТОЛЬКО при FEATURE_WAZZUP=1 в app.env; при выключенном флаге файл удаляется. Секретов здесь нет.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { envValue } from './secrets';
import { CrmctlError, type Deps } from './types';

const NGINX_CONF_DEFAULT = '/etc/nginx/conf.d/crm.conf';
export const WAZZUP_FRAME_HOSTS = 'https://*.wazzup24.com';

export const cspDir = (deps: Deps) => path.join(deps.paths.etcDir, 'nginx-csp.d');
export const frameConfFile = (deps: Deps) => path.join(cspDir(deps), 'frame.conf');
export const cspIncludeLine = (deps: Deps) => `include ${cspDir(deps)}/*.conf;`;

export const frameConf = (): string =>
  ['# Создан crmctl (D-270): окно чата Wazzup. Файл есть только при FEATURE_WAZZUP=1 в app.env.', `set $crm_frame_src "${WAZZUP_FRAME_HOSTS}";`, ''].join('\n');

/**
 * Конфиг nginx со старого шаблона (без frame-src): перед заголовком CSP ставит `set $crm_frame_src` и include,
 * в сам заголовок добавляет `frame-src $crm_frame_src`. Уже дополненный конфиг не меняется (added = 0).
 */
export function patchNginxCsp(body: string, includeLine: string): { body: string; added: number } {
  if (body.includes('$crm_frame_src')) return { body, added: 0 };
  const lines = body.split('\n');
  const out: string[] = [];
  let added = 0;
  for (const line of lines) {
    if (/^\s*add_header\s+Content-Security-Policy\s/.test(line) && line.includes("frame-ancestors 'none'")) {
      const indent = /^(\s*)/.exec(line)![1] as string;
      out.push(`${indent}set $crm_frame_src "'none'";`, `${indent}${includeLine}`, line.replace("frame-ancestors 'none'", "frame-ancestors 'none'; frame-src $crm_frame_src"));
      added++;
    } else out.push(line);
  }
  return { body: out.join('\n'), added };
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, body: string, mode: number): Promise<void> {
  const tmp = `${file}.crmctl-tmp`;
  await writeFile(tmp, body, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

/**
 * Для install и update: файл frame-src по флагу и, если нужен, include в конфиге nginx на хосте. После изменений —
 * `nginx -t` и reload; не прошёл `nginx -t` — конфиг и файл возвращаются как были, команда останавливается.
 */
export async function ensureFrameCsp(deps: Deps): Promise<{ changed: boolean; enabled: boolean }> {
  const { io } = deps;
  const appEnv = path.join(deps.paths.etcDir, 'app.env');
  const envBody = await readOrNull(appEnv);
  if (envBody === null) throw new CrmctlError(`Нет ${appEnv}: сначала crmctl install`);
  const enabled = envValue(envBody, 'FEATURE_WAZZUP')?.trim() === '1';
  const file = frameConfFile(deps);
  const before = await readOrNull(file);
  let changed = false;

  if (enabled) {
    await mkdir(cspDir(deps), { recursive: true, mode: 0o755 });
    if (before !== frameConf()) {
      await writeAtomic(file, frameConf(), 0o644);
      io.out(`nginx: записан ${file} (frame-src для окна чата Wazzup)`);
      changed = true;
    }
  } else if (before !== null) {
    await rm(file, { force: true });
    io.out(`nginx: удалён ${file} (FEATURE_WAZZUP выключен)`);
    changed = true;
  }

  const confPath = deps.env.CRM_NGINX_CONF?.trim() || NGINX_CONF_DEFAULT;
  const conf = await readOrNull(confPath);
  if (conf === null) {
    if (changed) io.out(`nginx: ${confPath} не найден — пропущено (nginx в compose-профиле edge читает ${cspDir(deps)} при перезапуске)`);
    return { changed, enabled };
  }
  // Конфиг дополняется только когда файл нужен: выключенную интеграцию старый шаблон не касается
  const patched = enabled ? patchNginxCsp(conf, cspIncludeLine(deps)) : { body: conf, added: 0 };
  if (patched.added > 0) {
    await writeAtomic(confPath, patched.body, 0o644);
    io.out(`nginx: в ${confPath} дописан frame-src (по умолчанию закрыт)`);
    changed = true;
  }
  if (!changed) return { changed, enabled };
  const t = await deps.exec.run('nginx', ['-t']);
  if (t.code !== 0) {
    if (patched.added > 0) await writeAtomic(confPath, conf, 0o644);
    if (before === null) await rm(file, { force: true });
    else await writeAtomic(file, before, 0o644);
    throw new CrmctlError(`nginx -t не прошёл, изменения возвращены: ${(t.stderr || t.stdout).trim()}`);
  }
  const r = await deps.exec.run('systemctl', ['reload', 'nginx']);
  if (r.code !== 0) throw new CrmctlError(`systemctl reload nginx: ${(r.stderr || r.stdout).trim()}`);
  io.out('nginx: конфигурация проверена (nginx -t) и перечитана');
  return { changed, enabled };
}
