// В репозитории нет закрытых ключей и файлов с именами закрытых ключей (D-315, docs/ops/release-design.md §7).
// Ключи тестов создаются на лету; ключи лицензий, релизов и стенда хранятся вне репозитория.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);

test('нет файлов *private* с ключами и PEM-блоков закрытых ключей в отслеживаемых файлах', () => {
  const marker = new RegExp(`-----BEGIN ${'[A-Z ]*'}PRIVATE KEY-----`);
  const files = tracked();
  const byName = files.filter((f) => /(^|\/)(license|release|stage)-private/.test(f) || /\.(pem|key|age)$/.test(f));
  assert.deepEqual(byName, [], 'файлы с именами закрытых ключей');
  const withBlock: string[] = [];
  for (const f of files) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|pdf|zst|tar)$/.test(f)) continue;
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (marker.test(text)) withBlock.push(f);
  }
  assert.deepEqual(withBlock, [], 'PEM закрытого ключа в репозитории');
});
