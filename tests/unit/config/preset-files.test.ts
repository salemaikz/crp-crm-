// Ассеты накладки: недоверенный вход (симлинки, имена, расширения, размер) и атомарное копирование.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ASSET_MAX_BYTES, installAssets, layerDir, loadLayers, logoExists, planAssets, PresetFilesError } from '../../../src/server/platform/config/preset-files';

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'crm-assets-'));
}

async function layer(root: string, files: Record<string, string | Buffer>): Promise<string> {
  const dir = path.join(root, `l${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(dir, 'assets', name), data);
  return dir;
}

const code = (c: string) => (e: unknown) => e instanceof PresetFilesError && e.code === c;

test('planAssets: нормальные файлы принимаются, позднейший слой перекрывает одноимённый', async () => {
  const root = await tmp();
  try {
    const a = await layer(root, { 'logo.svg': '<svg/>', 'font.woff2': 'x' });
    const b = await layer(root, { 'logo.svg': '<svg id="b"/>' });
    const plan = await planAssets([a, b]);
    assert.deepEqual(plan.map((p) => p.key).sort(), ['font.woff2', 'logo.svg']);
    assert.ok(plan.find((p) => p.key === 'logo.svg')?.file.startsWith(b));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planAssets: нет каталога assets — пусто', async () => {
  const root = await tmp();
  try {
    await mkdir(path.join(root, 'empty'));
    assert.deepEqual(await planAssets([path.join(root, 'empty')]), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planAssets: симлинк — ошибка', async () => {
  const root = await tmp();
  try {
    const a = await layer(root, {});
    await writeFile(path.join(root, 'secret.svg'), 'secret');
    await symlink(path.join(root, 'secret.svg'), path.join(a, 'assets', 'logo.svg'));
    await assert.rejects(planAssets([a]), code('symlink'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planAssets: подкаталог — ошибка', async () => {
  const root = await tmp();
  try {
    const a = await layer(root, {});
    await mkdir(path.join(a, 'assets', 'sub.svg'));
    await assert.rejects(planAssets([a]), PresetFilesError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planAssets: недопустимое имя и расширение', async () => {
  const root = await tmp();
  try {
    for (const name of ['Logo.svg', '..svg', '.hidden.svg', 'a b.svg', '-x.svg']) {
      const a = await layer(root, { [name]: 'x' });
      await assert.rejects(planAssets([a]), code('bad_name'), name);
    }
    for (const name of ['script.js', 'logo.svg.exe', 'logo.png.html', 'noext']) {
      const a = await layer(root, { [name]: 'x' });
      await assert.rejects(planAssets([a]), code('bad_ext'), name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planAssets: размер больше 2 МБ — ошибка, ровно 2 МБ — можно', async () => {
  const root = await tmp();
  try {
    const ok = await layer(root, { 'big.png': Buffer.alloc(ASSET_MAX_BYTES) });
    assert.equal((await planAssets([ok])).length, 1);
    const bad = await layer(root, { 'big.png': Buffer.alloc(ASSET_MAX_BYTES + 1) });
    await assert.rejects(planAssets([bad]), code('too_big'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installAssets: копирует, повтор ничего не меняет, чужие временные файлы не остаются', async () => {
  const root = await tmp();
  try {
    const a = await layer(root, { 'logo.svg': '<svg a/>', 'm.png': 'png' });
    const target = path.join(root, 'vol');
    const plan = await planAssets([a]);
    const r1 = await installAssets(plan, target);
    assert.deepEqual(r1.copied.sort(), ['logo.svg', 'm.png']);
    assert.equal(await readFile(path.join(target, 'logo.svg'), 'utf8'), '<svg a/>');
    const r2 = await installAssets(plan, target);
    assert.deepEqual(r2.copied, []);
    assert.deepEqual(r2.same.sort(), ['logo.svg', 'm.png']);
    // изменённый файл перезаписывается атомарно
    await writeFile(path.join(a, 'assets', 'logo.svg'), '<svg b/>');
    const r3 = await installAssets(await planAssets([a]), target);
    assert.deepEqual(r3.copied, ['logo.svg']);
    assert.equal(await readFile(path.join(target, 'logo.svg'), 'utf8'), '<svg b/>');
    assert.deepEqual((await readdir(target)).sort(), ['logo.svg', 'm.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installAssets: симлинк на месте ассета в томе — ошибка, цель не затирается', async () => {
  const root = await tmp();
  try {
    const a = await layer(root, { 'logo.svg': '<svg/>' });
    const target = path.join(root, 'vol');
    await mkdir(target);
    await writeFile(path.join(root, 'victim'), 'keep');
    await symlink(path.join(root, 'victim'), path.join(target, 'logo.svg'));
    await assert.rejects(installAssets(await planAssets([a]), target), code('symlink'));
    assert.equal(await readFile(path.join(root, 'victim'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('logoExists: из плана или из тома; неверное имя — нет', async () => {
  const root = await tmp();
  try {
    const a = await layer(root, { 'logo.svg': '<svg/>' });
    const plan = await planAssets([a]);
    assert.equal(await logoExists('logo.svg', plan, undefined), true);
    assert.equal(await logoExists('other.svg', plan, undefined), false);
    await writeFile(path.join(root, 'other.svg'), 'x');
    assert.equal(await logoExists('other.svg', [], root), true);
    assert.equal(await logoExists('../etc/passwd', [], root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('layerDir: ключ слоя — каталог пресетов, иначе путь; loadLayers читает preset.json', async () => {
  assert.equal(layerDir('kz', '/img/presets'), path.join('/img/presets', 'kz'));
  assert.equal(layerDir('/srv/clients/x', '/img/presets'), '/srv/clients/x');
  const root = await tmp();
  try {
    await mkdir(path.join(root, 'bad'));
    await writeFile(path.join(root, 'bad', 'preset.json'), '{не json');
    await assert.rejects(loadLayers([path.join(root, 'bad')], root), /не JSON/);
    await assert.rejects(loadLayers([], root), /не указаны слои/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
