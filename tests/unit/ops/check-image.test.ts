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
