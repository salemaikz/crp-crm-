// Каркас прогона изоляции: формат манифеста и загрузчик (сами манифесты ведут потоки).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineManifest } from '../../isolation/harness/manifest';
import { allEntries, loadManifests } from '../../isolation/harness/load';

test('defineManifest: дубль, объект без idParam и GET-мутация отклоняются', () => {
  const ok = { kind: 'route' as const, path: '/api/cards/[id]', method: 'GET' as const, perm: 'card.read' as const, target: 'object' as const, idParam: { name: 'id', entity: 'card' as const }, mutation: false };
  assert.equal(defineManifest('cards', [ok]).entries.length, 1);
  assert.throws(() => defineManifest('cards', [ok, ok]), /дубль/);
  assert.throws(() => defineManifest('cards', [{ ...ok, idParam: undefined }]), /idParam/);
  assert.throws(() => defineManifest('cards', [{ ...ok, mutation: true }]), /GET/);
  assert.throws(() => defineManifest('Cards', [ok]), /имя модуля/);
});

test('загрузчик: нет каталога — пусто; дубли между модулями — ошибка', async () => {
  assert.deepEqual(await loadManifests(join(tmpdir(), 'crm-no-such-manifest-dir')), []);
  const dir = mkdtempSync(join(tmpdir(), 'crm-manifest-'));
  try {
    const harness = join(import.meta.dirname, '..', '..', 'isolation', 'harness', 'manifest.ts');
    const body = (m: string) =>
      `import { defineManifest } from ${JSON.stringify(harness)};\nexport default defineManifest('${m}', [{ kind: 'route', path: '/api/x', method: 'GET', perm: 'authenticated', target: 'section', mutation: false }]);\n`;
    writeFileSync(join(dir, 'a.ts'), body('a'));
    assert.equal((await allEntries(dir)).length, 1);
    writeFileSync(join(dir, 'b.ts'), body('b'));
    await assert.rejects(allEntries(dir), /описан в a и b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
