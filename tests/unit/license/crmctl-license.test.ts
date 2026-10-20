// crmctl license install/status/verify и проверка лицензии новым образом (P10, D-211) без Docker:
// `docker run … license verify` фейк исполняет тем же кодом (verifyText) с одноразовыми ключами и водяным
// знаком «образа». Синтетика: клиент установки — из seedInstalled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { license as core } from '@crm/core';
import type { LicensePayload, Watermark } from '@crm/core/license';
import { imageLicenseVerifier, license, verifyText, LICENSE_FILE } from '../../../scripts/crmctl/license';
import { parseArgs } from '../../../scripts/crmctl/args';
import { makeFake, seedInstalled, type Fake } from '../ops/crmctl-fakes';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const INSTALL = '11111111-2222-3333-4444-555555555555';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = { 'prod-1': core.rawPublicKeyBase64(publicKey) };

async function setup(watermark: Watermark | ((image: string) => Watermark) = { customer: 'crp', buildId: 'b-1', builtAt: NOW - DAY }) {
  const runs: string[][] = [];
  const f: Fake = await makeFake(async (cmd, args) => {
    if (cmd !== 'docker' || args[0] !== 'run' || !args.includes('license')) return undefined;
    runs.push(args);
    const vi = args.indexOf('-v');
    const host = vi >= 0 ? (args[vi + 1] as string).split(':')[0]! : null;
    const text = host ? (await readFile(host, 'utf8')).trim() : null;
    const image = args[args.indexOf('dist/crmctl.mjs') - 1] as string;
    const wm = typeof watermark === 'function' ? watermark(image) : watermark;
    const v = verifyText(text, args[args.length - 1] as string, { keys: KEYS, watermark: wm });
    return { code: v.ok ? 0 : 3, stdout: `${JSON.stringify(v)}\n`, stderr: '' };
  }, NOW);
  await seedInstalled(f, '0.9.0');
  return { f, runs };
}

function lic(p: Partial<LicensePayload> = {}, key = privateKey): string {
  const payload: LicensePayload = {
    v: 1,
    lid: 'lic-0007',
    kid: 'prod-1',
    customer: 'crp',
    installId: INSTALL,
    issuedAt: NOW - DAY,
    notBefore: NOW - DAY,
    expiresAt: NOW + 60 * DAY,
    graceDays: 30,
    features: ['telephony.zadarma'],
    ...p,
  };
  const s = core.signingInput(payload);
  return core.assembleLicense(s, sign(null, Buffer.from(s, 'ascii'), key));
}

async function fileWith(f: Fake, text: string, name = 'new.crm'): Promise<string> {
  const p = path.join(f.dirs.lib, '..', name);
  await writeFile(p, `${text}\n`);
  return p;
}

const run = (f: Fake, ...argv: string[]) => license(f.deps, parseArgs(['license', ...argv]));
const target = (f: Fake) => path.join(f.dirs.lib, 'license', LICENSE_FILE);

test('install: проверка ядром текущего образа без сети, атомарная запись, прежняя — .prev', async () => {
  const { f, runs } = await setup();
  assert.equal(await run(f, 'install', await fileWith(f, lic())), 0);
  assert.equal((await readFile(target(f), 'utf8')).trim(), lic());
  assert.equal(((await stat(target(f))).mode & 0o777).toString(8), '644');
  const args = runs[0]!;
  assert.ok(args.includes('crm-app:0.9.0'));
  assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none']);
  assert.ok(args.includes('--read-only'));
  assert.ok(f.out.some((l) => l.includes('lic-0007')));
  // Вторая установка сохраняет прежнюю
  assert.equal(await run(f, 'install', await fileWith(f, lic({ lid: 'lic-0008' }), 'second.crm')), 0);
  assert.equal((await readFile(`${target(f)}.prev`, 'utf8')).trim(), lic());
});

test('install отказывает: подделка, чужой installId, чужой клиент, мусор, истёкшая, ещё не начавшаяся', async () => {
  const { f } = await setup();
  const [pre, body, sig] = lic().split('.') as [string, string, string];
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString()) as LicensePayload;
  forged.graceDays = 365;
  const cases: [string, RegExp][] = [
    [`${pre}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, /подпись не сходится/],
    [lic({}, generateKeyPairSync('ed25519').privateKey), /подпись не сходится/],
    [lic({ kid: 'other' }), /ключ подписи не знаком/],
    [lic({ installId: '99999999-0000-4000-8000-000000000000' }), /другой установки/],
    [lic({ customer: 'other-co' }), /другому клиенту/],
    ['не лицензия', /не лицензия CRM1/],
    [lic({ expiresAt: NOW - 31 * DAY, notBefore: NOW - 90 * DAY, issuedAt: NOW - 90 * DAY }), /срок и льготный период закончились/],
    [lic({ notBefore: NOW + DAY }), /ещё не начался/],
  ];
  for (const [text, re] of cases) {
    f.err.length = 0;
    await assert.rejects(run(f, 'install', await fileWith(f, text)), re, String(re));
  }
  await assert.rejects(stat(target(f)), { code: 'ENOENT' });
  await assert.rejects(run(f, 'install', path.join(f.dirs.lib, 'нет-такого.crm')), /нет/);
  await assert.rejects(run(f, 'install'), /Использование/);
});

test('install отказывает на образе без водяного знака клиента или с чужим знаком', async () => {
  for (const wm of [{ customer: null, buildId: null, builtAt: null }, { customer: 'other-co', buildId: 'b-1', builtAt: null }]) {
    const { f } = await setup(wm);
    await assert.rejects(run(f, 'install', await fileWith(f, lic())), /водяного знака|для клиента other-co/);
    await assert.rejects(stat(target(f)), { code: 'ENOENT' });
  }
});

test('install предупреждает о льготе и скором сроке', async () => {
  const { f } = await setup();
  assert.equal(await run(f, 'install', await fileWith(f, lic({ expiresAt: NOW - DAY, notBefore: NOW - 9 * DAY, issuedAt: NOW - 9 * DAY }))), 0);
  assert.ok(f.out.some((l) => l.includes('льготный период')));
  assert.equal(await run(f, 'install', await fileWith(f, lic({ expiresAt: NOW + 5 * DAY }), 'soon.crm')), 0);
  assert.ok(f.out.some((l) => l.includes('срок кончается')));
});

test('status: файл, вердикт ядра образа и строка license_state', async () => {
  const { f } = await setup();
  await mkdir(path.dirname(target(f)), { recursive: true });
  await writeFile(target(f), `${lic()}\n`);
  const row = { state: 'expired', reason: 'expired', last_seen_at: NOW, checked_at: NOW, invalid_since: null };
  const orig = f.deps.exec.run.bind(f.deps.exec);
  f.deps.exec.run = async (cmd, args, opts) =>
    opts?.input?.includes('row_to_json') ? { code: 0, stdout: `${JSON.stringify(row)}\n`, stderr: '' } : orig(cmd, args, opts);
  assert.equal(await run(f, 'status'), 0);
  const out = f.out.join('\n');
  assert.match(out, /installId: +11111111/);
  assert.match(out, /подпись и установка сходятся/);
  assert.match(out, /состояние: +expired \(срок и льготный период закончились\)/);
  assert.match(out, /telephony\.zadarma/);
});

test('verify (внутри образа): JSON и код выхода; без файла — missing с водяным знаком', async () => {
  const { f } = await setup();
  const file = await fileWith(f, lic());
  // В процессе тестов ядро — общая сборка с тестовым ключом: лицензия на одноразовом ключе не принимается
  assert.equal(await run(f, 'verify', file, INSTALL), 3);
  assert.deepEqual(JSON.parse(f.out.at(-1)!), { ok: false, reason: 'unknown_kid', watermark: { customer: null, buildId: null, builtAt: null } });
  assert.equal(await run(f, 'verify', path.join(f.dirs.lib, 'нет.crm'), INSTALL), 3);
  assert.equal(JSON.parse(f.out.at(-1)!).reason, 'missing');
  assert.deepEqual(verifyText(lic(), INSTALL, { keys: KEYS, watermark: { customer: 'crp', buildId: null, builtAt: null } }).ok, true);
});

test('проверка новым образом для update: нет файла — можно; битая или чужой образ — нельзя', async () => {
  const { f, runs } = await setup((image) => (image === 'crm-app:0.9.1' ? { customer: 'crp', buildId: 'b-2', builtAt: NOW - DAY } : { customer: null, buildId: null, builtAt: null }));
  const v = imageLicenseVerifier(f.deps);
  const dir = path.join(f.dirs.lib, 'license');
  await mkdir(dir, { recursive: true });
  assert.deepEqual(await v.verifyLicense({ image: 'crm-app:0.9.1', licenseDir: dir, installId: INSTALL }), { ok: true });
  assert.equal(runs.at(-1)!.includes('-v'), false, 'без файла ничего не монтируется');
  await writeFile(path.join(dir, LICENSE_FILE), lic());
  assert.deepEqual(await v.verifyLicense({ image: 'crm-app:0.9.1', licenseDir: dir, installId: INSTALL }), { ok: true });
  await writeFile(path.join(dir, LICENSE_FILE), lic({ installId: '99999999-0000-4000-8000-000000000000' }));
  const bad = await v.verifyLicense({ image: 'crm-app:0.9.1', licenseDir: dir, installId: INSTALL });
  assert.equal(bad.ok, false);
  const general = await v.verifyLicense({ image: 'crm-app:0.9.2', licenseDir: dir, installId: INSTALL });
  assert.equal(general.ok, false);
  assert.match(!general.ok ? general.reason : '', /без водяного знака/);
});

test('update: лицензия прежней сборки — можно с предупреждением, пока идут 7 суток от сборки нового образа (D-290)', async () => {
  const at = (builtAt: number | null) => (image: string) =>
    image === 'crm-app:0.9.1' ? { customer: 'crp', buildId: 'b-2', builtAt } : { customer: 'crp', buildId: 'b-1', builtAt: NOW - 30 * DAY };
  const prev = lic({ buildId: 'b-1' });
  for (const [builtAt, ok] of [[NOW - DAY, true], [NOW - 7 * DAY + 1, true], [NOW - 7 * DAY, false], [null, false]] as const) {
    const { f } = await setup(at(builtAt));
    const dir = path.join(f.dirs.lib, 'license');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, LICENSE_FILE), prev);
    const v = await imageLicenseVerifier(f.deps).verifyLicense({ image: 'crm-app:0.9.1', licenseDir: dir, installId: INSTALL });
    assert.equal(v.ok, ok, String(builtAt));
    if (v.ok) assert.match(v.warning ?? '', /прежней сборки.*b-2.*crmctl license install/);
    else assert.match(v.reason, builtAt === null ? /без времени сборки/ : /истекли/);
  }
  // Чужая подпись при том же образе — отказ, льгота её не касается
  const { f } = await setup(at(NOW - DAY));
  const dir = path.join(f.dirs.lib, 'license');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, LICENSE_FILE), lic({ buildId: 'b-1' }, generateKeyPairSync('ed25519').privateKey));
  assert.equal((await imageLicenseVerifier(f.deps).verifyLicense({ image: 'crm-app:0.9.1', licenseDir: dir, installId: INSTALL })).ok, false);
});

test('status: сборка образа и конец льготы для лицензии прежней сборки; образ без времени сборки — без льготы', async () => {
  for (const builtAt of [NOW - 2 * DAY, undefined]) {
    const { f } = await setup({ customer: 'crp', buildId: 'b-2', builtAt: builtAt ?? null });
    // Образ до D-290 не сообщает builtAt вовсе: crmctl считает его null
    if (builtAt === undefined) {
      const orig = f.deps.exec.run.bind(f.deps.exec);
      f.deps.exec.run = async (cmd, args, opts) => {
        const r = await orig(cmd, args, opts);
        if (cmd !== 'docker' || !args.includes('verify')) return r;
        const j = JSON.parse(r.stdout) as { watermark: Record<string, unknown> };
        delete j.watermark.builtAt;
        return { ...r, stdout: `${JSON.stringify(j)}\n` };
      };
    }
    await mkdir(path.dirname(target(f)), { recursive: true });
    await writeFile(target(f), `${lic({ buildId: 'b-1' })}\n`);
    const orig = f.deps.exec.run.bind(f.deps.exec);
    f.deps.exec.run = async (cmd, args, opts) =>
      opts?.input?.includes('row_to_json')
        ? { code: 0, stdout: `${JSON.stringify({ state: 'invalid', reason: 'wrong_build', invalid_since: NOW - DAY })}\n`, stderr: '' }
        : orig(cmd, args, opts);
    assert.equal(await run(f, 'status'), 0);
    const out = f.out.join('\n');
    assert.match(out, /выдана для другой сборки/);
    assert.match(out, /не сходится с:/);
    if (builtAt === undefined) assert.match(out, /льгота: +нет \(образ без времени сборки\)/);
    else {
      assert.match(out, /сборка образа: b-2, собрана/);
      assert.match(out, new RegExp(`льгота до: +${new Date(builtAt + 7 * DAY).toISOString()}`));
    }
  }
});
