// Файл логотипа для шапки и входа (D-333). Единственный источник — каталог CRM_ASSETS_DIR (том crm_assets, D-061);
// имя файла — только theme.logo из настроек, из запроса оно не берётся никогда. Файл — недоверенный вход:
// строгое имя, только обычный файл в самом каталоге (без симлинков), предел размера, белый список типов.
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { ASSET_MAX_BYTES, ASSET_NAME_RE, PresetFilesError, readAssetFile } from '../config/preset-files';

export type LogoFile = { bytes: Buffer; contentType: string; hash: string };

/** Расширения, которые отдаём как картинку; шрифты и прочее из белого списка ассетов логотипом не бывают. */
const CONTENT_TYPES: Readonly<Record<string, string>> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

type Env = Record<string, string | undefined>;
export type LogoDeps = {
  /** Чтение файла; в тестах подменяется, чтобы считать обращения. */
  read?: (file: string, maxBytes: number) => Promise<Buffer>;
};

type CacheEntry = { file: string; ino: number; size: number; mtimeMs: number; value: LogoFile };
let cache: CacheEntry | null = null;
const warned = new Set<string>();

/** Одна строка в журнал на код отказа и процесс; путь тома не выводим. */
function warnOnce(code: string): void {
  if (warned.has(code)) return;
  warned.add(code);
  console.warn(`[brand] логотип недоступен: ${code}`);
}

/** Сбросить кэш и «уже писали» (тесты). */
export function resetLogoCacheForTests(): void {
  cache = null;
  warned.clear();
}

/** Адрес файла логотипа в каталоге или null, если имя не проходит проверку. */
function logoPath(key: string, dir: string): { file: string; contentType: string } | null {
  if (!ASSET_NAME_RE.test(key) || key.includes('..')) return null;
  const contentType = CONTENT_TYPES[path.extname(key)];
  if (!contentType) return null;
  const root = path.resolve(dir);
  const file = path.join(root, key);
  if (path.dirname(file) !== root) return null;
  return { file, contentType };
}

export async function readLogo(key: string, env: Env = process.env, deps: LogoDeps = {}): Promise<LogoFile | null> {
  const dir = env.CRM_ASSETS_DIR?.trim();
  if (!dir) {
    warnOnce('no_dir'); // в шапке текст: каталог ассетов не задан
    return null;
  }
  const target = logoPath(key, dir);
  if (!target) {
    warnOnce('bad_name');
    return null;
  }
  try {
    // lstat на каждый вызов: файл перечитывается, только если изменились ino, size или mtime (installAssets пишет через rename)
    const st = await lstat(target.file);
    // FIFO, сокет, устройство, каталог, симлинк: до open не доходим (открытие FIFO блокирует поток)
    if (!st.isFile()) {
      cache = null;
      warnOnce('not_file');
      return null;
    }
    if (cache && cache.file === target.file && cache.ino === st.ino && cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache.value;
    const bytes = await (deps.read ?? readAssetFile)(target.file, ASSET_MAX_BYTES);
    const value: LogoFile = { bytes, contentType: target.contentType, hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
    cache = { file: target.file, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, value };
    return value;
  } catch (e) {
    cache = null;
    if (e instanceof PresetFilesError) warnOnce(e.code);
    else if ((e as NodeJS.ErrnoException).code === 'ENOENT') warnOnce('missing');
    else warnOnce('read_error');
    return null;
  }
}
