// Формат релизного пакета (docs/ops/release-design.md §2.2, §7): строгий читатель tar+zstd отвергает ссылки,
// устройства, pax/GNU, обход пути, повторы, манифест не первым или слишком большой, обрезанный архив.
// Опасные архивы собираются вручную по байтам: наш писатель такие не создаёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  MANIFEST_MAX_BYTES,
  isSafePackagePath,
  parseManifest,
  readArchive,
  writeArchive,
  type Member,
} from '../../../scripts/crmctl/package-format';
import { manifestFor } from './crmctl-fakes';

interface Raw {
  name: string;
  type?: string;
  body?: Buffer;
  link?: string;
  magic?: string;
  size?: number;
}

/** Сырой tar: ничего не проверяется, чтобы можно было собрать заведомо плохой архив. */
function rawTar(entries: Raw[], opts: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = e.body ?? Buffer.alloc(0);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 'utf8');
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(`${(e.size ?? body.length).toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.fill(0x20, 148, 156);
    h.write(e.type ?? '0', 156, 'ascii');
    if (e.link) h.write(e.link, 157, 'ascii');
    h.write(e.magic ?? 'ustar\x0000', 257, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (opts.end !== false) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function archiveOf(tar: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pkgfmt-'));
  const f = path.join(dir, 'a.tar.zst');
  await writeFile(f, zstdCompressSync(tar));
  return f;
}

const MAN = { name: 'manifest.json', body: Buffer.from('{}') };

async function read(tar: Buffer): Promise<Member[]> {
  const seen: Member[] = [];
  await readArchive(await archiveOf(tar), (m) => {
    seen.push(m);
    return undefined;
  });
  return seen;
}

test('корректный архив читается; каталог и файл различаются', async () => {
  const seen = await read(rawTar([MAN, { name: 'compose/', type: '5' }, { name: 'compose/a.yaml', body: Buffer.from('x') }]));
  assert.deepEqual(seen.map((m) => [m.path, m.kind, m.size]), [['manifest.json', 'file', 2], ['compose', 'dir', 0], ['compose/a.yaml', 'file', 1]]);
});

const BAD: [string, Raw[], RegExp][] = [
  ['символическая ссылка', [MAN, { name: 'evil', type: '2', link: '/etc/passwd' }], /тип члена/],
  ['жёсткая ссылка', [MAN, { name: 'evil', type: '1', link: 'manifest.json' }], /тип члена/],
  ['символьное устройство', [MAN, { name: 'dev', type: '3' }], /тип члена/],
  ['блочное устройство', [MAN, { name: 'dev', type: '4' }], /тип члена/],
  ['fifo', [MAN, { name: 'fifo', type: '6' }], /тип члена/],
  ['pax-заголовок', [MAN, { name: 'pax', type: 'x', body: Buffer.from('20 path=../x\n') }], /тип члена/],
  ['глобальный pax', [MAN, { name: 'pax', type: 'g', body: Buffer.from('') }], /тип члена/],
  ['GNU длинное имя', [MAN, { name: '././@LongLink', type: 'L', body: Buffer.from('x\0') }], /тип члена/],
  ['GNU magic', [{ ...MAN, magic: 'ustar  \0' }], /POSIX ustar/],
  ['обход пути ..', [MAN, { name: '../x', body: Buffer.from('a') }], /небезопасный путь/],
  ['обход пути в середине', [MAN, { name: 'a/../../x', body: Buffer.from('a') }], /небезопасный путь/],
  ['абсолютный путь', [MAN, { name: '/etc/x', body: Buffer.from('a') }], /небезопасный путь/],
  ['не ASCII в имени', [MAN, { name: 'ф.txt', body: Buffer.from('a') }], /небезопасный путь/],
  ['пустой сегмент', [MAN, { name: 'a//b', body: Buffer.from('a') }], /небезопасный путь/],
  ['повтор пути', [MAN, { name: 'a', body: Buffer.from('1') }, { name: 'a', body: Buffer.from('2') }], /повторяется/],
  ['повтор manifest.json', [MAN, MAN], /повторяется/],
  ['manifest.json не первым', [{ name: 'a', body: Buffer.from('1') }, MAN], /первым членом/],
  ['каталог первым', [{ name: 'manifest.json/', type: '5' }], /первым членом/],
  ['manifest.json больше 256 КиБ', [{ name: 'manifest.json', size: MANIFEST_MAX_BYTES + 1, body: Buffer.alloc(MANIFEST_MAX_BYTES + 1) }], /256 КиБ/],
  ['каталог с размером', [MAN, { name: 'd/', type: '5', size: 5, body: Buffer.alloc(512) }], /ненулевой размер/],
];

for (const [name, entries, re] of BAD) {
  test(`читатель отвергает: ${name}`, async () => {
    await assert.rejects(read(rawTar(entries)), re);
  });
}

test('читатель отвергает: обрезанный архив (нет маркера конца)', async () => {
  await assert.rejects(read(rawTar([MAN], { end: false })), /обрезан/);
});

test('читатель отвергает: архив обрезан посреди файла', async () => {
  const tar = rawTar([MAN, { name: 'big', body: Buffer.alloc(4096, 7) }]);
  await assert.rejects(read(tar.subarray(0, 512 + 512 + 512 + 1024)), /обрезан|распаковывается/);
});

test('читатель отвергает: испорченный zstd', async () => {
  const f = await archiveOf(rawTar([MAN]));
  const raw = await readFile(f);
  await writeFile(f, raw.subarray(0, Math.floor(raw.length / 2)));
  await assert.rejects(readArchive(f, () => undefined), /zstd|обрезан/);
});

test('читатель отвергает: данные после маркера конца', async () => {
  const tar = Buffer.concat([rawTar([MAN]), Buffer.from('trailing garbage')]);
  await assert.rejects(read(tar), /после маркера/);
});

test('читатель отвергает: испорченная контрольная сумма и пустой архив', async () => {
  const tar = rawTar([MAN]);
  tar[10] = 0x5a;
  await assert.rejects(read(tar), /контрольная сумма/);
  await assert.rejects(read(Buffer.alloc(1024)), /пуст/);
});

test('писатель: воспроизводимый результат, manifest.json первым, порядок по имени', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pkgfmt-'));
  const members = [
    { path: 'z.txt', kind: 'file' as const, data: Buffer.from('z') },
    { path: 'manifest.json', kind: 'file' as const, data: Buffer.from('{}') },
    { path: 'a', kind: 'dir' as const },
    { path: 'a/b.sh', kind: 'file' as const, data: Buffer.from('#!/bin/sh\n'), exec: true },
  ];
  await writeArchive(path.join(dir, '1.tar.zst'), members, 1_790_000_000_000);
  await writeArchive(path.join(dir, '2.tar.zst'), [...members].reverse(), 1_790_000_000_000);
  assert.ok((await readFile(path.join(dir, '1.tar.zst'))).equals(await readFile(path.join(dir, '2.tar.zst'))));
  const seen: Member[] = [];
  await readArchive(path.join(dir, '1.tar.zst'), (m) => {
    seen.push(m);
    return undefined;
  });
  assert.deepEqual(seen.map((m) => m.path), ['manifest.json', 'a', 'a/b.sh', 'z.txt']);
  assert.equal(seen[2]?.exec, true);
  assert.equal(seen[3]?.exec, false);
});

test('писатель не перезаписывает файл и не принимает небезопасный путь', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pkgfmt-'));
  const man = { path: 'manifest.json', kind: 'file' as const, data: Buffer.from('{}') };
  await writeArchive(path.join(dir, 'a.tar.zst'), [man], 1);
  await assert.rejects(writeArchive(path.join(dir, 'a.tar.zst'), [man], 1));
  await assert.rejects(writeArchive(path.join(dir, 'b.tar.zst'), [man, { path: '../x', kind: 'file', data: Buffer.alloc(0) }], 1), /Небезопасный путь/);
  await assert.rejects(writeArchive(path.join(dir, 'c.tar.zst'), [{ path: 'a', kind: 'file', data: Buffer.alloc(0) }], 1), /manifest/);
});

test('isSafePackagePath', () => {
  for (const ok of ['a', 'a/b.c-d_e', 'images.tar', 'compose/postgres-init/10-roles.sh']) assert.equal(isSafePackagePath(ok), true, ok);
  for (const bad of ['', '/a', 'a/', '../a', 'a/..', 'a/./b', 'a//b', 'a b', 'ф', 'a\\b', 'x'.repeat(101)]) assert.equal(isSafePackagePath(bad), false, bad);
});

test('манифест: строгая схема, неизвестные поля и формат 1 отвергаются', () => {
  const ok = manifestFor('1.0.0');
  assert.equal(parseManifest(Buffer.from(JSON.stringify(ok))).version, '1.0.0');
  const reject = (m: unknown, re: RegExp) => assert.throws(() => parseManifest(Buffer.from(JSON.stringify(m))), re);
  reject({ ...ok, extra: 1 }, /не прошёл проверку/);
  reject({ ...ok, format: 1 }, /format/);
  const noFiles: Record<string, unknown> = { ...ok };
  delete noFiles.files;
  reject(noFiles, /files/);
  reject({ ...ok, files: [{ path: '../x', sha256: 'a'.repeat(64), size: 1 }] }, /files/);
  reject({ ...ok, files: [...ok.files, ok.files[0]] }, /повторяется/);
  reject({ ...ok, files: [{ path: 'manifest.sig', sha256: 'a'.repeat(64), size: 1 }] }, /manifest\.sig/);
  reject({ ...ok, releaseKeys: [{ kid: 'stage-x', sha256: 'a'.repeat(64) }] }, /releaseKeys/);
  reject({ ...ok, images: [{ ref: 'crm-app:9.9.9', digest: ok.images[0]!.digest }] }, /нет образа/);
  assert.throws(() => parseManifest(Buffer.from('{')), /JSON/);
});
