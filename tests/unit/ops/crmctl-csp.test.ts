// CSP frame-src окна чата Wazzup (D-270, дизайн §8.8): по умолчанию окна сторонних сайтов закрыты; домен Wazzup
// дописывает файл nginx-csp.d/frame.conf только при FEATURE_WAZZUP=1; старый конфиг дополняется без потерь.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cspIncludeLine, ensureFrameCsp, frameConf, frameConfFile, patchNginxCsp } from '../../../scripts/crmctl/nginxCsp';
import { SEED_APP_ENV, makeFake, type Fake } from './crmctl-fakes';

const TEMPLATE = await readFile('deploy/nginx/crm.conf.template', 'utf8');
/** Конфиг на хосте со старого шаблона: без frame-src, set и include. */
const OLD_CONF = TEMPLATE.split('\n')
  .filter((l) => !l.trim().startsWith('set $crm_frame_src') && !l.includes('nginx-csp.d'))
  .join('\n')
  .replace("frame-ancestors 'none'; frame-src $crm_frame_src", "frame-ancestors 'none'");
const appEnv = (f: Fake) => path.join(f.dirs.etc, 'app.env');
const nginxCalls = (f: Fake) => f.calls.filter((c) => c.cmd === 'nginx' || c.cmd === 'systemctl').map((c) => [c.cmd, ...c.args].join(' '));
const exists = (p: string) => stat(p).then(() => true, () => false);

async function setup(wazzup: '1' | '0' | null, conf: string | null): Promise<Fake> {
  const f = await makeFake();
  await writeFile(appEnv(f), `${SEED_APP_ENV}${wazzup === null ? '' : `FEATURE_WAZZUP=${wazzup}\n`}`, { mode: 0o600 });
  if (conf !== null) {
    await mkdir(path.dirname(f.dirs.nginxConf), { recursive: true });
    await writeFile(f.dirs.nginxConf, conf);
  }
  return f;
}

test('шаблон: frame-src по умолчанию закрыт, домен подставляется только include из nginx-csp.d', () => {
  assert.match(TEMPLATE, /set \$crm_frame_src "'none'";/);
  assert.match(TEMPLATE, /include \/etc\/crm\/nginx-csp\.d\/\*\.conf;/);
  assert.match(TEMPLATE, /frame-ancestors 'none'; frame-src \$crm_frame_src" always;/);
  assert.ok(!/wazzup/i.test(TEMPLATE.replace(/#.*$/gm, '')), 'домена Wazzup в самом шаблоне нет');
  // set и include стоят раньше add_header CSP: include переопределяет значение
  assert.ok(TEMPLATE.indexOf('include /etc/crm/nginx-csp.d') < TEMPLATE.indexOf('add_header Content-Security-Policy'));
  assert.ok(TEMPLATE.indexOf("set $crm_frame_src") < TEMPLATE.indexOf('include /etc/crm/nginx-csp.d'));
  assert.match(frameConf(), /set \$crm_frame_src "https:\/\/\*\.wazzup24\.com";/);
});

test('patchNginxCsp: старый конфиг дополняется, повтор и новый шаблон не меняются', () => {
  const include = '/etc/crm/nginx-csp.d/*.conf';
  const p = patchNginxCsp(OLD_CONF, `include ${include};`);
  assert.equal(p.added, 1);
  assert.match(p.body, /set \$crm_frame_src "'none'";\n\s+include \/etc\/crm\/nginx-csp\.d\/\*\.conf;\n\s+add_header Content-Security-Policy .*frame-src \$crm_frame_src" always;/);
  assert.equal(patchNginxCsp(p.body, `include ${include};`).added, 0);
  assert.equal(patchNginxCsp(TEMPLATE, `include ${include};`).added, 0);
  assert.equal(p.body.replace(/\n.*crm_frame_src.*\n\s+include [^\n]+\n/, '\n').replace('; frame-src $crm_frame_src', ''), OLD_CONF.replace(/\n.*crm_frame_src.*\n/, '\n'), 'остальной текст не изменился');
});

test('FEATURE_WAZZUP=1: файл frame-src записан, старый конфиг дополнен, nginx -t и reload; повтор — без изменений', async () => {
  const f = await setup('1', OLD_CONF);
  const r = await ensureFrameCsp(f.deps);
  assert.deepEqual(r, { changed: true, enabled: true });
  assert.equal(await readFile(frameConfFile(f.deps), 'utf8'), frameConf());
  assert.ok((await readFile(f.dirs.nginxConf, 'utf8')).includes(cspIncludeLine(f.deps)));
  assert.deepEqual(nginxCalls(f), ['nginx -t', 'systemctl reload nginx']);
  const again = await ensureFrameCsp(f.deps);
  assert.equal(again.changed, false);
  assert.equal(nginxCalls(f).length, 2, 'повторный запуск не перечитывает nginx');
});

test('флаг выключен или не задан: файла нет, старый конфиг не трогается, nginx не перечитывается', async () => {
  for (const flag of ['0', null] as const) {
    const f = await setup(flag, OLD_CONF);
    assert.deepEqual(await ensureFrameCsp(f.deps), { changed: false, enabled: false });
    assert.equal(await exists(frameConfFile(f.deps)), false);
    assert.equal(await readFile(f.dirs.nginxConf, 'utf8'), OLD_CONF);
    assert.deepEqual(nginxCalls(f), []);
  }
});

test('флаг выключили после включения: файл удаляется и nginx перечитывается', async () => {
  const f = await setup('1', TEMPLATE);
  await ensureFrameCsp(f.deps);
  assert.equal(await exists(frameConfFile(f.deps)), true);
  await writeFile(appEnv(f), `${SEED_APP_ENV}FEATURE_WAZZUP=0\n`);
  const r = await ensureFrameCsp(f.deps);
  assert.deepEqual(r, { changed: true, enabled: false });
  assert.equal(await exists(frameConfFile(f.deps)), false);
  assert.deepEqual(nginxCalls(f).slice(-2), ['nginx -t', 'systemctl reload nginx']);
});

test('конфига nginx на хосте нет: только файл, без вызовов nginx', async () => {
  const f = await setup('1', null);
  await ensureFrameCsp(f.deps);
  assert.equal(await readFile(frameConfFile(f.deps), 'utf8'), frameConf());
  assert.deepEqual(nginxCalls(f), []);
});

test('nginx -t не прошёл: конфиг и файл возвращаются как были, команда останавливается', async () => {
  const f = await makeFake((cmd, args) => (cmd === 'nginx' && args[0] === '-t' ? { code: 1, stdout: '', stderr: 'bad config' } : undefined));
  await writeFile(appEnv(f), `${SEED_APP_ENV}FEATURE_WAZZUP=1\n`, { mode: 0o600 });
  await mkdir(path.dirname(f.dirs.nginxConf), { recursive: true });
  await writeFile(f.dirs.nginxConf, OLD_CONF);
  await assert.rejects(ensureFrameCsp(f.deps), /nginx -t не прошёл/);
  assert.equal(await readFile(f.dirs.nginxConf, 'utf8'), OLD_CONF);
  assert.equal(await exists(frameConfFile(f.deps)), false);
});
