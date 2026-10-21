// Формат релизного пакета (docs/ops/release-design.md §2–3, D-315): строгий читатель и писатель
// POSIX ustar + zstd на node:zlib, манифест формата 2, файл подписи и байты для подписи.
// Системные tar и zstd не нужны: ссылки, обход пути и лишние члены архива отвергает сам читатель.
// Модуль не зависит от ядра и БД: его используют и хостовый crmctl, и scripts/release-*.ts.
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { z } from 'zod';
import { VERSION_RE } from './manifest';
import { CrmctlError } from './types';

// ---------------------------------------------------------------- пути и имена

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_MAX_BYTES = 256 * 1024;
/** Предел размера одного файла: 11 восьмеричных цифр ustar. */
export const MAX_MEMBER_BYTES = 0o77777777777;
/** Сколько нулей разрешено после маркера конца (ustar дополняет архив до 10 КиБ). */
const MAX_TRAILING_ZEROS = 1024 * 1024;

const PATH_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** Относительный путь члена пакета: ASCII, до 100 знаков, без `..`, `.`, пустых сегментов и `/` в начале. */
export function isSafePackagePath(p: string): boolean {
  if (!PATH_RE.test(p) || p.startsWith('/') || p.endsWith('/')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------- манифест формата 2

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const kidRe = /^(rel|stage|test)-[A-Za-z0-9._-]{1,40}$/;

export const manifestSchema = z
  .object({
    format: z.literal(2),
    customer: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().regex(VERSION_RE),
    buildId: z.string().min(1).max(64),
    builtAt: z.number().int().positive(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    schemaVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.sql$/),
    configSchemaVersion: z.number().int().nonnegative(),
    minFromVersion: z.union([z.literal(''), z.string().regex(VERSION_RE)]),
    images: z
      .array(
        z
          .object({
            ref: z.string().regex(/^crm-app:[0-9A-Za-z][0-9A-Za-z._-]*$/),
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1),
    // Пусто допустимо только в пакете общей сборки (стенд): владелец такой пакет не подписывает
    releaseKeys: z.array(z.object({ kid: z.string().regex(/^rel-[A-Za-z0-9._-]{1,40}$/), sha256: sha256Hex }).strict()),
    files: z
      .array(
        z
          .object({
            path: z.string().refine(isSafePackagePath, 'небезопасный путь'),
            sha256: sha256Hex,
            size: z.number().int().nonnegative().max(MAX_MEMBER_BYTES),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof manifestSchema>;

/** Разбор строгой схемой. Текст ошибки не повторяет значения полей. */
export function parseManifest(bytes: Buffer): ReleaseManifest {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new CrmctlError('manifest.json не разбирается как JSON');
  }
  const res = manifestSchema.safeParse(json);
  if (!res.success) {
    const where = res.error.issues.map((i) => i.path.join('.') || '(корень)').join(', ');
    throw new CrmctlError(`manifest.json не прошёл проверку, поля: ${where}`);
  }
  const m = res.data;
  if (!m.images.some((i) => i.ref === `crm-app:${m.version}`)) {
    throw new CrmctlError(`В manifest.json нет образа crm-app:${m.version}`);
  }
  const paths = new Set<string>();
  for (const f of m.files) {
    if (f.path === MANIFEST_NAME || f.path === 'manifest.sig') throw new CrmctlError(`В files нельзя указывать ${f.path}`);
    if (paths.has(f.path)) throw new CrmctlError('В files повторяется путь');
    paths.add(f.path);
  }
  return m;
}

// ---------------------------------------------------------------- подпись

/** Префикс отделяет подпись релиза от подписей другого назначения (лицензии и т. п.). */
export const SIGN_PREFIX = 'crm-release-v1\n';

export function signingBytes(manifestBytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(SIGN_PREFIX, 'utf8'), manifestBytes]);
}

const sigFileSchema = z
  .object({ format: z.literal(1), kid: z.string().regex(kidRe), sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) })
  .strict();

export function encodeSigFile(kid: string, sig: Buffer): string {
  if (sig.length !== 64) throw new CrmctlError('Подпись Ed25519 должна быть 64 байта');
  return `${JSON.stringify({ format: 1, kid, sig: sig.toString('base64') })}\n`;
}

export function parseSigFile(text: string): { kid: string; sig: Buffer } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CrmctlError('Файл подписи не разбирается как JSON');
  }
  const res = sigFileSchema.safeParse(json);
  if (!res.success) throw new CrmctlError('Файл подписи имеет неверный формат');
  const sig = Buffer.from(res.data.sig, 'base64');
  if (sig.length !== 64) throw new CrmctlError('Файл подписи: подпись должна быть 64 байта');
  return { kid: res.data.kid, sig };
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Открытый ключ Ed25519 из сырых 32 байт в base64. */
export function publicKeyFromRaw(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== b64) throw new CrmctlError('Открытый ключ Ed25519: нужно 32 байта в base64');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function rawPublicKeyBase64(key: KeyObject): string {
  const der = (key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('base64');
}

/** Отпечаток ключа: sha256 сырых 32 байт (так ключ записан в manifest.releaseKeys). */
export function keyFingerprint(rawB64: string): string {
  return createHash('sha256').update(Buffer.from(rawB64, 'base64')).digest('hex');
}

export function verifyManifestSignature(key: KeyObject, manifestBytes: Buffer, sig: Buffer): boolean {
  try {
    return edVerify(null, signingBytes(manifestBytes), key, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- ustar: заголовки

export interface Member {
  path: string;
  kind: 'file' | 'dir';
  size: number;
  /** Есть ли бит исполнения у владельца в заголовке. */
  exec: boolean;
}

export interface Sink {
  write(chunk: Buffer): void | Promise<void>;
  end(): void | Promise<void>;
}

export type OnMember = (m: Member, index: number) => Sink | undefined | Promise<Sink | undefined>;

const BLOCK = 512;

function octal(n: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  b.write(n.toString(8).padStart(len - 1, '0'), 'ascii');
  return b;
}

function buildHeader(name: string, kind: 'file' | 'dir', size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(kind === 'dir' ? `${name}/` : name, 0, 'ascii');
  octal(mode, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(mtime, 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write(kind === 'dir' ? '5' : '0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

function parseOctal(field: Buffer, what: string): number {
  if (field[0]! & 0x80) throw new CrmctlError(`Архив: ${what} в двоичной записи не поддерживается`);
  const s = field.toString('ascii').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(s)) throw new CrmctlError(`Архив: поле ${what} повреждено`);
  return parseInt(s, 8);
}

function isZero(b: Buffer): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

function parseHeader(h: Buffer): Member {
  const stored = parseOctal(h.subarray(148, 156), 'checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  if (sum !== stored) throw new CrmctlError('Архив: контрольная сумма заголовка не сходится');
  const type = String.fromCharCode(h[156]!);
  if (type !== '0' && type !== '5') {
    // ссылки (1, 2), устройства (3, 4, 6), pax (x, g), GNU (L, K), старый формат (NUL)
    throw new CrmctlError(`Архив: недопустимый тип члена «${type === '\0' ? 'NUL' : type}» (разрешены файлы и каталоги)`);
  }
  if (h.toString('ascii', 257, 263) !== 'ustar\0' || h.toString('ascii', 263, 265) !== '00') {
    throw new CrmctlError('Архив: нужен POSIX ustar (без GNU и pax)');
  }
  if (!isZero(h.subarray(157, 257))) throw new CrmctlError('Архив: ссылки в заголовке не допускаются');
  if (!isZero(h.subarray(345, 500))) throw new CrmctlError('Архив: поле prefix не допускается (пути до 100 знаков)');
  if (!isZero(h.subarray(329, 345))) throw new CrmctlError('Архив: номера устройств не допускаются');
  const nameEnd = h.indexOf(0);
  let name = h.toString('ascii', 0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd);
  if (type === '5') {
    if (!name.endsWith('/')) throw new CrmctlError('Архив: имя каталога без /');
    name = name.slice(0, -1);
  }
  if (!isSafePackagePath(name)) throw new CrmctlError('Архив: небезопасный путь члена');
  const size = parseOctal(h.subarray(124, 136), 'size');
  if (type === '5' && size !== 0) throw new CrmctlError('Архив: у каталога ненулевой размер');
  if (size > MAX_MEMBER_BYTES) throw new CrmctlError('Архив: размер члена больше предела');
  const mode = parseOctal(h.subarray(100, 108), 'mode');
  return { path: name, kind: type === '5' ? 'dir' : 'file', size, exec: (mode & 0o100) !== 0 };
}

// ---------------------------------------------------------------- ustar: читатель

async function* decompressed(file: string): AsyncGenerator<Buffer> {
  const rs = createReadStream(file);
  const dz = createZstdDecompress();
  rs.on('error', (e) => dz.destroy(e));
  rs.pipe(dz);
  try {
    for await (const c of dz) yield c as Buffer;
  } catch (e) {
    throw new CrmctlError(`Архив не распаковывается (zstd): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rs.destroy();
    dz.destroy();
  }
}

/**
 * Потоковый строгий читатель. Первый член обязан быть manifest.json (не больше 256 КиБ), пути не
 * повторяются, тип — только файл или каталог, после двух нулевых блоков идут только нули.
 * onMember вызывается на заголовке; возвращённый Sink получает тело члена. Любое нарушение — исключение.
 */
export async function readArchive(file: string, onMember: OnMember): Promise<void> {
  type State = 'header' | 'body' | 'pad' | 'done';
  let state = 'header' as State;
  const hdr = Buffer.alloc(BLOCK);
  let hdrFill = 0;
  let zeroBlocks = 0;
  let remaining = 0;
  let pad = 0;
  let sink: Sink | undefined;
  let index = 0;
  let trailing = 0;
  const seen = new Set<string>();

  const finishBody = async (): Promise<void> => {
    await sink?.end();
    sink = undefined;
    state = pad > 0 ? 'pad' : 'header';
  };

  for await (const chunk of decompressed(file)) {
    let off = 0;
    while (off < chunk.length) {
      if (state === 'done') {
        trailing += chunk.length - off;
        if (trailing > MAX_TRAILING_ZEROS || !isZero(chunk.subarray(off))) throw new CrmctlError('Архив: данные после маркера конца');
        break;
      }
      if (state === 'pad') {
        const n = Math.min(pad, chunk.length - off);
        off += n;
        pad -= n;
        if (pad === 0) state = 'header';
        continue;
      }
      if (state === 'body') {
        const n = Math.min(remaining, chunk.length - off);
        await sink?.write(chunk.subarray(off, off + n));
        off += n;
        remaining -= n;
        if (remaining === 0) await finishBody();
        continue;
      }
      // header
      const n = Math.min(BLOCK - hdrFill, chunk.length - off);
      chunk.copy(hdr, hdrFill, off, off + n);
      hdrFill += n;
      off += n;
      if (hdrFill < BLOCK) continue;
      hdrFill = 0;
      if (isZero(hdr)) {
        zeroBlocks++;
        if (zeroBlocks === 2) {
          if (index === 0) throw new CrmctlError('Архив пуст: нет manifest.json');
          state = 'done';
        }
        continue;
      }
      if (zeroBlocks > 0) throw new CrmctlError('Архив: заголовок после нулевого блока');
      const m = parseHeader(hdr);
      if (index === 0) {
        if (m.path !== MANIFEST_NAME || m.kind !== 'file') throw new CrmctlError('Архив: первым членом должен быть manifest.json');
        if (m.size > MANIFEST_MAX_BYTES) throw new CrmctlError('Архив: manifest.json больше 256 КиБ');
      }
      if (seen.has(m.path)) throw new CrmctlError('Архив: путь повторяется');
      seen.add(m.path);
      sink = await onMember(m, index++);
      remaining = m.size;
      pad = (BLOCK - (m.size % BLOCK)) % BLOCK;
      if (m.kind === 'dir' || m.size === 0) {
        await sink?.end();
        sink = undefined;
        state = 'header';
        if (m.size === 0) pad = 0;
      } else {
        state = 'body';
      }
    }
  }
  if (state !== 'done') throw new CrmctlError('Архив обрезан: нет маркера конца');
}

// ---------------------------------------------------------------- ustar: писатель

export type WriteMember =
  | { path: string; kind: 'dir' }
  | { path: string; kind: 'file'; data: Buffer; exec?: boolean }
  | { path: string; kind: 'file'; file: string; size: number; exec?: boolean };

/**
 * Воспроизводимая запись: manifest.json первым, остальные по имени, mtime фиксирован, владелец 0:0,
 * права 0644/0755. Файл назначения не перезаписывается (flag wx).
 */
export async function writeArchive(out: string, members: WriteMember[], mtimeMs: number): Promise<void> {
  const mtime = Math.floor(mtimeMs / 1000);
  const rest = members.filter((m) => m.path !== MANIFEST_NAME).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const first = members.find((m) => m.path === MANIFEST_NAME);
  if (!first || first.kind !== 'file') throw new CrmctlError('В пакет нужен manifest.json');
  const ordered = [first, ...rest];
  const seen = new Set<string>();
  for (const m of ordered) {
    if (!isSafePackagePath(m.path)) throw new CrmctlError(`Небезопасный путь в пакете: ${m.path}`);
    if (seen.has(m.path)) throw new CrmctlError(`Путь повторяется: ${m.path}`);
    seen.add(m.path);
  }
  async function* gen(): AsyncGenerator<Buffer> {
    for (const m of ordered) {
      if (m.kind === 'dir') {
        yield buildHeader(m.path, 'dir', 0, 0o755, mtime);
        continue;
      }
      const size = 'data' in m ? m.data.length : m.size;
      if (size > MAX_MEMBER_BYTES) throw new CrmctlError(`Файл больше 8 ГиБ: ${m.path}`);
      yield buildHeader(m.path, 'file', size, m.exec ? 0o755 : 0o644, mtime);
      let written = 0;
      if ('data' in m) {
        yield m.data;
        written = m.data.length;
      } else {
        const st = await stat(m.file);
        if (st.size !== m.size) throw new CrmctlError(`Размер файла изменился: ${m.path}`);
        for await (const c of createReadStream(m.file)) {
          yield c as Buffer;
          written += (c as Buffer).length;
        }
        if (written !== m.size) throw new CrmctlError(`Размер файла изменился: ${m.path}`);
      }
      const padLen = (BLOCK - (written % BLOCK)) % BLOCK;
      if (padLen > 0) yield Buffer.alloc(padLen);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  await pipeline(Readable.from(gen()), createZstdCompress(), createWriteStream(out, { flags: 'wx' }));
}

// ---------------------------------------------------------------- проверка набора файлов

/** sha256 и размер файла потоком. */
export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const c of createReadStream(file)) {
    h.update(c as Buffer);
    size += (c as Buffer).length;
  }
  return { sha256: h.digest('hex'), size };
}

/**
 * Читает архив целиком (для проверки без записи или с записью через sink), сверяя каждый член с манифестом:
 * подпись проверяет verifyManifest ДО разбора остальных членов. Возвращает байты и разбор манифеста.
 */
export async function scanArchive(
  file: string,
  opts: {
    verifyManifest: (bytes: Buffer) => void | Promise<void>;
    /** Разбор манифеста выполнен, подпись принята: можно готовить место для записи. */
    onAccepted?: (m: ReleaseManifest) => void | Promise<void>;
    /** Приёмник файлов (по пути в архиве); не нужен для проверки без записи. */
    sinkFor?: (relPath: string, m: Member) => Sink | Promise<Sink>;
    onDir?: (relPath: string) => void | Promise<void>;
  },
): Promise<{ manifestBytes: Buffer; manifest: ReleaseManifest }> {
  let manifestBytes = Buffer.alloc(0);
  let manifest: ReleaseManifest | undefined;
  const expected = new Map<string, { sha256: string; size: number }>();
  const done = new Set<string>();

  await readArchive(file, async (m, index) => {
    if (index === 0) {
      const parts: Buffer[] = [];
      return {
        write: (c) => void parts.push(Buffer.from(c)),
        end: async () => {
          manifestBytes = Buffer.concat(parts);
          await opts.verifyManifest(manifestBytes);
          manifest = parseManifest(manifestBytes);
          for (const f of manifest.files) expected.set(f.path, { sha256: f.sha256, size: f.size });
          await opts.onAccepted?.(manifest);
        },
      };
    }
    if (!manifest) throw new CrmctlError('Архив: манифест не принят');
    if (m.kind === 'dir') {
      if (expected.has(m.path)) throw new CrmctlError('Архив: каталог с именем файла из манифеста');
      await opts.onDir?.(m.path);
      return undefined;
    }
    const want = expected.get(m.path);
    if (!want) throw new CrmctlError(`Архив: файл вне manifest.json: ${m.path}`);
    if (want.size !== m.size) throw new CrmctlError(`Архив: размер ${m.path} не совпадает с manifest.json`);
    const inner = opts.sinkFor ? await opts.sinkFor(m.path, m) : undefined;
    const h = createHash('sha256');
    return {
      write: async (c) => {
        h.update(c);
        await inner?.write(c);
      },
      end: async () => {
        if (h.digest('hex') !== want.sha256) throw new CrmctlError(`Архив: sha256 файла ${m.path} не совпадает с manifest.json`);
        done.add(m.path);
        await inner?.end();
      },
    };
  });
  if (!manifest) throw new CrmctlError('В архиве нет manifest.json');
  for (const p of expected.keys()) {
    if (!done.has(p)) throw new CrmctlError(`В архиве нет файла из manifest.json: ${p}`);
  }
  return { manifestBytes, manifest };
}
