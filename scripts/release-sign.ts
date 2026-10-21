// Подпись релизного пакета (docs/ops/release-design.md §5.3, D-315). ЗАПУСКАЕТ ТОЛЬКО ВЛАДЕЛЕЦ, офлайн, у себя.
// Закрытый ключ — файл вне репозитория (путь аргументом); утилита ключей не содержит и в сеть ничего не шлёт.
// В образ поставки не входит. Ядро @crm/core не нужно.
//
//   tsx scripts/release-sign.ts keygen --kid rel-2026a --out <путь вне репозитория>/release-private-rel-2026a.pem
//   tsx scripts/release-sign.ts pubkey --key <файл>
//   tsx scripts/release-sign.ts sign <архив> --key <файл> --kid rel-2026a --expect-sha256 <из сводки CI>
//                               [--known-keys <файл>] [--accept-new-key] [--out <файл подписи>]
//   tsx scripts/release-sign.ts verify <архив> [--sig F] --pubkey <base64>
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  encodeSigFile,
  hashFile,
  keyFingerprint,
  parseSigFile,
  publicKeyFromRaw,
  rawPublicKeyBase64,
  scanArchive,
  signingBytes,
  verifyManifestSignature,
} from './crmctl/package-format';

export interface SignIo {
  out: (l: string) => void;
  err: (l: string) => void;
  /** Вопрос владельцу (подтверждение версии). */
  ask: (q: string) => Promise<string>;
}

const USAGE = `Использование (только владелец, офлайн):
  release-sign keygen --kid rel-2026a --out <путь вне репозитория>/release-private-rel-2026a.pem
  release-sign pubkey --key <файл>
  release-sign sign <архив> --key <файл> --kid rel-2026a --expect-sha256 <sha256 из сводки CI>
                    [--known-keys <файл>] [--accept-new-key] [--out <файл подписи>]
  release-sign verify <архив> [--sig <файл>] --pubkey <base64>`;

class UsageError extends Error {
  override name = 'UsageError';
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new UsageError(`нужен --${name}`);
  return v;
}

function loadPrivateKey(file: string): KeyObject {
  const key = createPrivateKey(readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new UsageError('ключ не Ed25519');
  return key;
}

/** Каталог внутри рабочего дерева git: поиск .git вверх по пути. */
function insideGitTree(file: string): boolean {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function main(argv: string[], io: SignIo): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    const { values: f, positionals } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: {
        kid: { type: 'string' },
        out: { type: 'string' },
        key: { type: 'string' },
        sig: { type: 'string' },
        pubkey: { type: 'string' },
        'expect-sha256': { type: 'string' },
        'known-keys': { type: 'string' },
        'accept-new-key': { type: 'boolean' },
      },
    });
    if (cmd === 'keygen') {
      const out = need(f.out, 'out');
      const kid = need(f.kid, 'kid');
      if (!/^(rel|stage)-[A-Za-z0-9._-]{1,40}$/.test(kid)) throw new UsageError('kid: rel-… (ключ релизов) или stage-… (ключ стенда)');
      if (insideGitTree(out)) throw new UsageError('закрытый ключ нельзя класть внутрь рабочего дерева git: укажите путь вне репозитория');
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      // flag 'wx': существующий ключ не перезаписывается
      writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      const pub = rawPublicKeyBase64(publicKey);
      io.out(`kid: ${kid}`);
      io.out(`открытый ключ: ${pub}`);
      io.out(`отпечаток sha256: ${keyFingerprint(pub)}`);
      io.out(`для сборки crmctl (release_keys): ${JSON.stringify({ [kid]: pub })}`);
      io.out(`закрытый ключ записан в ${out} — храните офлайн, в репозиторий, CI и облако не кладите`);
      return 0;
    }
    if (cmd === 'pubkey') {
      io.out(rawPublicKeyBase64(createPublicKey(loadPrivateKey(need(f.key, 'key')))));
      return 0;
    }
    if (cmd === 'verify') {
      const archive = need(positionals[0], 'архив');
      const key = publicKeyFromRaw(need(f.pubkey, 'pubkey'));
      const sigPath = f.sig ?? archive.replace(/\.tar\.zst$/, '.manifest.sig');
      const { kid, sig } = parseSigFile(readFileSync(sigPath, 'utf8'));
      const r = await scanArchive(archive, {
        verifyManifest: (bytes) => {
          if (!verifyManifestSignature(key, bytes, sig)) throw new Error('подпись не сходится');
        },
      });
      io.out(`подпись ${kid} верна: клиент ${r.manifest.customer}, версия ${r.manifest.version}, файлов ${r.manifest.files.length}`);
      return 0;
    }
    if (cmd === 'sign') {
      const archive = need(positionals[0], 'архив');
      const key = loadPrivateKey(need(f.key, 'key'));
      const kid = need(f.kid, 'kid');
      if (!/^rel-[A-Za-z0-9._-]{1,40}$/.test(kid)) throw new UsageError('kid: ключ релизов rel-…');
      const expect = need(f['expect-sha256'], 'expect-sha256').toLowerCase();
      // 1. sha256 архива совпадает с числом, которое владелец переписал со страницы прогона CI
      const h = await hashFile(archive);
      if (h.sha256 !== expect) throw new Error(`sha256 архива ${h.sha256} не совпадает с --expect-sha256: архив подменён или это другой прогон`);
      // 2. Весь архив проверяется тем же читателем, что и crmctl (без записи на диск)
      const { manifest, manifestBytes } = await scanArchive(archive, { verifyManifest: () => {} });
      if (manifest.releaseKeys.length === 0) throw new Error('в manifest.releaseKeys пусто: это пакет общей сборки, боевым ключом его не подписывают');
      const ownPub = rawPublicKeyBase64(createPublicKey(key));
      const own = { kid, sha256: keyFingerprint(ownPub) };
      if (!manifest.releaseKeys.some((k) => k.kid === own.kid && k.sha256 === own.sha256)) {
        throw new Error(`ключ ${kid} не входит в manifest.releaseKeys: crmctl этой версии его не признал бы`);
      }
      // 3. Сводка
      io.out(`клиент:        ${manifest.customer}`);
      io.out(`версия:        ${manifest.version} (minFromVersion ${manifest.minFromVersion || '—'})`);
      io.out(`commit:        ${manifest.commit}`);
      io.out(`собран:        ${new Date(manifest.builtAt).toISOString()} · buildId ${manifest.buildId}`);
      io.out(`схема БД:      ${manifest.schemaVersion} · настройки v${manifest.configSchemaVersion}`);
      for (const i of manifest.images) io.out(`образ:         ${i.ref} ${i.digest}`);
      io.out(`файлов:        ${manifest.files.length}`);
      io.out('releaseKeys (crmctl будет доверять только им):');
      // 4. Ключи, которых нет у владельца, не подписываются молча
      const known: Record<string, string> = f['known-keys'] ? (JSON.parse(readFileSync(f['known-keys'], 'utf8')) as Record<string, string>) : {};
      known[kid] ??= ownPub;
      const unknown: string[] = [];
      for (const k of manifest.releaseKeys) {
        const ok = typeof known[k.kid] === 'string' && keyFingerprint(known[k.kid] as string) === k.sha256;
        io.out(`  ${k.kid}  ${k.sha256}${ok ? '' : '  <-- НЕ ИЗВЕСТЕН'}`);
        if (!ok) unknown.push(k.kid);
      }
      if (unknown.length > 0 && !f['accept-new-key']) {
        throw new Error(`в releaseKeys есть неизвестные ключи (${unknown.join(', ')}): сверьте с --known-keys или повторите с --accept-new-key`);
      }
      // 5. Подтверждение версией
      const answer = (await io.ask(`Введите версию ${manifest.version} для подтверждения: `)).trim();
      if (answer !== manifest.version) throw new Error('версия не подтверждена: подпись не выдана');
      // 6. Подпись
      const sig = edSign(null, signingBytes(manifestBytes), key);
      if (!verifyManifestSignature(createPublicKey(key), manifestBytes, sig)) throw new Error('самопроверка подписи не прошла');
      const outFile = f.out ?? archive.replace(/\.tar\.zst$/, '.manifest.sig');
      writeFileSync(outFile, encodeSigFile(kid, sig), { mode: 0o644, flag: 'wx' });
      io.out(`Подпись записана: ${outFile}`);
      io.out(`sha256 манифеста: ${hex(manifestBytes)}`);
      io.out(`sha256 архива для первой установки (передать root клиента отдельным каналом): ${h.sha256}`);
      return 0;
    }
    io.err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(`${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if ((e as { code?: unknown }).code === 'EEXIST') {
      io.err('файл уже существует — не перезаписываю');
      return 1;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  // Строки читаются итератором: ввод из канала (printf ... | release-sign) не теряется, если поток уже закрыт
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  main(process.argv.slice(2), {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    ask: async (q) => {
      process.stdout.write(q);
      return (await lines.next()).value ?? '';
    },
  }).then((c) => {
    rl.close();
    process.exitCode = c;
  });
}
