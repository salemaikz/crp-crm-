// scripts/check-image.sh в режиме --dir (без docker): тот же набор правил, что и для образа (ARCHITECTURE §8.2 п. 4).
// Q2a, круг 2: если трассировка standalone положила node_modules/@crm/core каталогом, `ln -sfn` в Dockerfile его не
// заменит, и исходники пакета остались бы в образе под node_modules — правило «*.ts вне node_modules» их не видит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(process.cwd(), 'scripts', 'check-image.sh');
const check = (dir: string) => spawnSync('bash', [SCRIPT, '--dir', dir], { encoding: 'utf8' });

async function app(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'check-image-'));
  await mkdir(path.join(root, 'app', 'packages', 'core', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'app', 'packages', 'core', 'dist', 'index.cjs'), 'module.exports = {};\n');
  await mkdir(path.join(root, 'app', 'node_modules', '@crm'), { recursive: true });
  await mkdir(path.join(root, 'app', 'node_modules', 'zod'), { recursive: true });
  await writeFile(path.join(root, 'app', 'node_modules', 'zod', 'index.d.ts'), 'export {};\n');
  return root;
}

test('check-image --dir: @crm/core ссылкой на packages/core — чисто', async () => {
  const root = await app();
  await symlink('../../packages/core', path.join(root, 'app', 'node_modules', '@crm', 'core'));
  const r = check(root);
  assert.equal(r.status, 0, r.stderr);
});

test('check-image --dir: @crm/core каталогом с src/ и *.ts под node_modules — нарушение', async () => {
  const root = await app();
  await mkdir(path.join(root, 'app', 'node_modules', '@crm', 'core', 'src'), { recursive: true });
  await writeFile(path.join(root, 'app', 'node_modules', '@crm', 'core', 'src', 'index.ts'), 'export {};\n');
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /исходники пакетов @crm\/\* в node_modules/);
});

test('check-image --dir: *.d.ts пакета @crm/* (объявления типов) — не нарушение', async () => {
  const root = await app();
  await mkdir(path.join(root, 'app', 'node_modules', '@crm', 'core', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'app', 'node_modules', '@crm', 'core', 'dist', 'index.d.ts'), 'export {};\n');
  const r = check(root);
  assert.equal(r.status, 0, r.stderr);
});

// Режим образа с подменённым docker (PATH): `docker export` отдаёт tar файловой системы. Прерванная распаковка
// (docker export упал на середине или поток оборван) — не чистый образ, даже если /app успел появиться.
async function fakeDocker(mode: 'ok' | 'export-fails' | 'truncated'): Promise<NodeJS.ProcessEnv> {
  const root = await app();
  await writeFile(path.join(root, 'app', 'big.bin'), Buffer.alloc(256 * 1024, 1));
  const tarFile = path.join(root, '..', `${path.basename(root)}.tar`);
  const t = spawnSync('tar', ['-c', '-f', tarFile, '-C', root, '.'], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  const bin = await mkdtemp(path.join(tmpdir(), 'check-image-bin-'));
  const exportCmd =
    mode === 'ok' ? `cat '${tarFile}'`
    : mode === 'truncated' ? `head -c 70000 '${tarFile}'`
    : `head -c 70000 '${tarFile}'; exit 1`;
  await writeFile(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash\ncase "$1" in\n  create) echo cid-fake ;;\n  export) ${exportCmd} ;;\n  rm) exit 0 ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
}
const checkImage = (env: NodeJS.ProcessEnv) => spawnSync('bash', [SCRIPT, 'crm-app:0.0.0-test'], { encoding: 'utf8', env });

test('check-image <образ>: полный экспорт чистого образа — OK', async () => {
  const r = checkImage(await fakeDocker('ok'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check-image: OK/);
});

test('check-image <образ>: docker export упал на середине — FAIL, а не чистый образ', async () => {
  const r = checkImage(await fakeDocker('export-fails'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /не извлечена/);
});

test('check-image <образ>: поток экспорта оборван (tar не дочитал архив) — FAIL', async () => {
  const r = checkImage(await fakeDocker('truncated'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /не извлечена/);
});
