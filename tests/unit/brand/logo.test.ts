// readLogo (D-333): отказы по каждому условию, кэш без повторного чтения, новый хеш после подмены файла.
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { readLogo, resetLogoCacheForTests } from '../../../src/server/platform/brand/logo';
import { ASSET_MAX_BYTES, readAssetFile } from '../../../src/server/platform/config/preset-files';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="4"><rect width="10" height="4"/></svg>';
let dir: string;
const env = () => ({ CRM_ASSETS_DIR: dir });

beforeEach(async () => {
  resetLogoCacheForTests();
  dir = await mkdtemp(path.join(tmpdir(), 'crm-logo-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('svg, png и webp: байты, тип и хеш', async () => {
  const cases: Array<[string, string]> = [['a.svg', 'image/svg+xml'], ['a.png', 'image/png'], ['a.webp', 'image/webp']];
  for (const [name, type] of cases) {
    await writeFile(path.join(dir, name), SVG);
    resetLogoCacheForTests();
    const r = await readLogo(name, env());
    assert.ok(r, name);
    assert.equal(r.contentType, type);
    assert.equal(r.bytes.toString(), SVG);
    assert.equal(r.hash, createHash('sha256').update(SVG).digest('hex').slice(0, 16));
  }
});

test('нет переменной или файла — null', async () => {
  assert.equal(await readLogo('a.svg', {}), null);
  assert.equal(await readLogo('a.svg', { CRM_ASSETS_DIR: '  ' }), null);
  assert.equal(await readLogo('a.svg', env()), null);
});

test('симлинк, каталог и слишком большой файл — null', async () => {
  await writeFile(path.join(dir, 'real.svg'), SVG);
  await symlink(path.join(dir, 'real.svg'), path.join(dir, 'link.svg'));
  await mkdir(path.join(dir, 'dir.svg'));
  await writeFile(path.join(dir, 'big.svg'), Buffer.alloc(ASSET_MAX_BYTES + 1, 0x20));
  for (const n of ['link.svg', 'dir.svg', 'big.svg']) assert.equal(await readLogo(n, env()), null, n);
});

test('недопустимые имена и расширения — null, даже если файл есть', async () => {
  await writeFile(path.join(dir, 'x.svg'), SVG);
  await writeFile(path.join(dir, 'X.svg'), SVG);
  await mkdir(path.join(dir, 'a'));
  await writeFile(path.join(dir, 'a', 'b.svg'), SVG);
  await writeFile(path.join(dir, 'f.woff2'), 'font');
  for (const n of ['../x.svg', 'X.svg', 'a/b.svg', 'f.woff2', '', 'a..svg']) assert.equal(await readLogo(n, env()), null, n);
});

test('кэш: без изменений файла он не читается заново; rename даёт новый хеш', async () => {
  await writeFile(path.join(dir, 'a.svg'), SVG);
  let reads = 0;
  const read = (f: string, max: number) => {
    reads++;
    return readAssetFile(f, max);
  };
  const first = await readLogo('a.svg', env(), { read });
  const second = await readLogo('a.svg', env(), { read });
  assert.equal(reads, 1);
  assert.equal(second, first);
  const next = SVG.replace('width="10"', 'width="12"');
  await writeFile(path.join(dir, '.tmp'), next);
  await rename(path.join(dir, '.tmp'), path.join(dir, 'a.svg'));
  const third = await readLogo('a.svg', env(), { read });
  assert.equal(reads, 2);
  assert.notEqual(third?.hash, first?.hash);
  assert.equal(third?.bytes.toString(), next);
});

/** Журнал предупреждений за время вызова. */
async function warnings<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const spy = mock.method(console, 'warn', () => {});
  try {
    const result = await fn();
    return { result, lines: spy.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    spy.mock.restore();
  }
}

test('не обычный файл (FIFO или сокет): null с not_file, open не вызывается', async () => {
  const file = path.join(dir, 'pipe.svg');
  let server: net.Server | null = null;
  try {
    execFileSync('mkfifo', [file]);
  } catch {
    // mkfifo нет: берём сокет — тоже не обычный файл
    server = net.createServer();
    await new Promise<void>((ok, fail) => server!.once('error', fail).listen(file, ok));
  }
  try {
    let reads = 0;
    const read = async () => {
      reads++;
      return Buffer.alloc(0);
    };
    const { result, lines } = await warnings(() => readLogo('pipe.svg', env(), { read }));
    assert.equal(result, null);
    assert.equal(reads, 0);
    assert.deepEqual(lines, ['[brand] логотип недоступен: not_file']);
  } finally {
    if (server) await new Promise((ok) => server!.close(ok));
  }
});

test('журнал: no_dir, missing, один раз на код и без пути', async () => {
  const a = await warnings(async () => [await readLogo('a.svg', {}), await readLogo('a.svg', { CRM_ASSETS_DIR: ' ' })]);
  assert.deepEqual(a.lines, ['[brand] логотип недоступен: no_dir']);
  const b = await warnings(async () => [await readLogo('a.svg', env()), await readLogo('a.svg', env())]);
  assert.deepEqual(b.lines, ['[brand] логотип недоступен: missing']);
  assert.ok(!b.lines.join('').includes(dir));
});
