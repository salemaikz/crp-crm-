// Подпись лицензии (ARCHITECTURE §8.4, DEPLOY §8.2, D-029, D-211). ЗАПУСКАЕТ ТОЛЬКО ВЛАДЕЛЕЦ, офлайн, у себя.
// Закрытый ключ — файл вне репозитория, путь передаётся аргументом; утилита ключа не содержит и никуда его
// не отправляет. В образ поставки утилита не входит.
//
//   tsx scripts/license-sign.ts keygen --out <закрытый.pem> --kid <kid>
//       новая пара Ed25519: закрытый ключ в файл (0600, не перезаписывается); на экран — kid и открытый
//       ключ для сборки ядра (build.mjs --license-keys, __CRM_LICENSE_KEYS__)
//   tsx scripts/license-sign.ts pubkey --key <закрытый.pem>
//   tsx scripts/license-sign.ts sign --key <закрытый.pem> --kid <kid> --customer <клиент> --install-id <id>
//       --expires <ГГГГ-ММ-ДД | ISO> [--grace-days 30] [--not-before <дата>] [--features a,b] [--seats N]
//       [--build-id <id>] [--lid <номер>] [--out <файл>]
//       Дата без времени — конец дня по Астане (UTC+5). Печатает лицензию (или пишет в --out) и сводку.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { license } from '@crm/core';

const { DAY_MS, assembleLicense, decodeLicense, licensePayloadSchema, rawPublicKeyBase64, signingInput } = license;

export type SignIo = { out: (l: string) => void; err: (l: string) => void };

const USAGE = `Использование (только владелец, офлайн):
  license-sign keygen --out <закрытый.pem> --kid <kid>
  license-sign pubkey --key <закрытый.pem>
  license-sign sign --key <закрытый.pem> --kid <kid> --customer <клиент> --install-id <id> --expires <дата>
                    [--grace-days 30] [--not-before <дата>] [--features a,b] [--seats N] [--build-id <id>]
                    [--lid <номер>] [--out <файл>]`;

class UsageError extends Error {
  override name = 'UsageError';
}

const ASTANA_OFFSET = '+05:00';

/** `ГГГГ-ММ-ДД` → конец (или начало) дня по Астане; полная дата ISO — как есть. */
export function parseDate(v: string, edge: 'start' | 'end'): number {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const ms = day ? Date.parse(`${v}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}${ASTANA_OFFSET}`) : Date.parse(v);
  if (!Number.isFinite(ms) || (!day && !/(Z|[+-]\d{2}:\d{2})$/.test(v))) {
    throw new UsageError(`дата ${JSON.stringify(v)}: ГГГГ-ММ-ДД или ISO с поясом`);
  }
  return ms;
}

function loadPrivateKey(file: string): KeyObject {
  const key = createPrivateKey(readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new UsageError('ключ не Ed25519');
  return key;
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new UsageError(`нужен --${name}`);
  return v;
}

function int(v: string | undefined, name: string, def?: number): number | undefined {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name}: целое число`);
  return Number(v);
}

export type SignOptions = {
  key: KeyObject;
  kid: string;
  customer: string;
  installId: string;
  expiresAt: number;
  notBefore?: number;
  graceDays?: number;
  features?: string[];
  seats?: number;
  buildId?: string;
  lid?: string;
  now: number;
};

/** Собрать, подписать и тут же проверить лицензию (своим же открытым ключом). */
export function signLicense(o: SignOptions): string {
  const payload = licensePayloadSchema.parse({
    v: 1,
    lid: o.lid ?? `lic-${randomUUID().slice(0, 8)}`,
    kid: o.kid,
    customer: o.customer,
    installId: o.installId,
    issuedAt: o.now,
    // По умолчанию — сутки назад: часы сервера и ноутбука владельца расходятся
    notBefore: o.notBefore ?? o.now - DAY_MS,
    expiresAt: o.expiresAt,
    graceDays: o.graceDays ?? 30,
    features: o.features ?? [],
    ...(o.seats !== undefined ? { seats: o.seats } : {}),
    ...(o.buildId !== undefined ? { buildId: o.buildId } : {}),
  });
  const signed = signingInput(payload);
  const token = assembleLicense(signed, sign(null, Buffer.from(signed, 'ascii'), o.key));
  const d = decodeLicense(token);
  if (!d.ok || !verify(null, d.value.signed, createPublicKey(o.key), d.value.signature)) throw new Error('самопроверка подписи не прошла');
  return token;
}

export function main(argv: string[], io: SignIo = { out: (l) => console.log(l), err: (l) => console.error(l) }, now = Date.now()): number {
  try {
    const [cmd, ...rest] = argv;
    const { values: f } = parseArgs({
      args: rest,
      strict: true,
      options: {
        out: { type: 'string' },
        key: { type: 'string' },
        kid: { type: 'string' },
        customer: { type: 'string' },
        'install-id': { type: 'string' },
        expires: { type: 'string' },
        'not-before': { type: 'string' },
        'grace-days': { type: 'string' },
        features: { type: 'string' },
        seats: { type: 'string' },
        'build-id': { type: 'string' },
        lid: { type: 'string' },
      },
    });
    if (cmd === 'keygen') {
      const out = need(f.out, 'out');
      const kid = need(f.kid, 'kid');
      license.parseTrustedKeys({ [kid]: 'A'.repeat(43) + '=' }); // проверка формата kid
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      // flag 'wx': существующий ключ не перезаписывается
      writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      io.out(`kid: ${kid}`);
      io.out(`открытый ключ: ${rawPublicKeyBase64(publicKey)}`);
      io.out(`для сборки ядра: ${JSON.stringify({ [kid]: rawPublicKeyBase64(publicKey) })}`);
      io.out(`закрытый ключ записан в ${out} — храните офлайн, в репозиторий и CI не кладите`);
      return 0;
    }
    if (cmd === 'pubkey') {
      io.out(rawPublicKeyBase64(createPublicKey(loadPrivateKey(need(f.key, 'key')))));
      return 0;
    }
    if (cmd === 'sign') {
      const features = f.features ? f.features.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const token = signLicense({
        key: loadPrivateKey(need(f.key, 'key')),
        kid: need(f.kid, 'kid'),
        customer: need(f.customer, 'customer'),
        installId: need(f['install-id'], 'install-id'),
        expiresAt: parseDate(need(f.expires, 'expires'), 'end'),
        ...(f['not-before'] ? { notBefore: parseDate(f['not-before'], 'start') } : {}),
        ...(f['grace-days'] !== undefined ? { graceDays: int(f['grace-days'], 'grace-days') as number } : {}),
        features,
        ...(f.seats !== undefined ? { seats: int(f.seats, 'seats') as number } : {}),
        ...(f['build-id'] ? { buildId: f['build-id'] } : {}),
        ...(f.lid ? { lid: f.lid } : {}),
        now,
      });
      const d = decodeLicense(token);
      if (!d.ok) throw new Error('лицензия не разбирается');
      const p = d.value.payload;
      if (f.out) writeFileSync(f.out, `${token}\n`, { mode: 0o644, flag: 'wx' });
      else io.out(token);
      io.err(
        `lid ${p.lid} · kid ${p.kid} · клиент ${p.customer} · installId ${p.installId} · ` +
          `с ${new Date(p.notBefore).toISOString()} до ${new Date(p.expiresAt).toISOString()} · льгота ${p.graceDays} дн. · ` +
          `модули: ${p.features.join(', ') || '—'}${f.out ? ` · файл ${f.out}` : ''}`,
      );
      return 0;
    }
    io.err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(`${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if ((e as { name?: unknown }).name === 'ZodError') {
      const issue = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
      io.err(`поля лицензии: ${issue ? `${issue.path.join('.') || '—'}: ${issue.message}` : 'не прошли проверку'}`);
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

if (isEntry()) process.exitCode = main(process.argv.slice(2));
