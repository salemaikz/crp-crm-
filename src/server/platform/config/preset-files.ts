// Файлы пресета: поиск слоёв на диске и копирование ассетов накладки (D-061, README §3.1).
// Ассеты — недоверенный вход (каталог накладки лежит вне образа): только обычные файлы, имя без
// каталогов и «..», белый список расширений, предел размера, запись через временный файл и rename.
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as coreConfig } from '@crm/core';
import type { PresetLayer } from '@crm/core/config';

const { parseLayer } = coreConfig;

/** Как `AssetKey` схемы (packages/core/src/config/schema/primitives.ts): имя файла без каталогов. */
export const ASSET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const ASSET_EXTENSIONS = ['.svg', '.png', '.webp', '.woff2'] as const;
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;

export type PresetFilesErrorCode = 'missing' | 'symlink' | 'not_file' | 'too_big' | 'bad_name' | 'bad_ext' | 'invalid';

export class PresetFilesError extends Error {
  override name = 'PresetFilesError';
  constructor(
    message: string,
    readonly code: PresetFilesErrorCode = 'invalid',
  ) {
    super(message);
  }
}

export function presetsRoot(env: Record<string, string | undefined> = process.env): string {
  return env.CRM_PRESETS_DIR?.trim() || path.join(process.cwd(), 'presets');
}

export type LoadedLayer = { spec: string; dir: string; layer: PresetLayer };

const LAYER_KEY_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** Ключ слоя (`base`, `kz`, …) → `<presets>/<ключ>`; иначе путь к каталогу накладки. */
export function layerDir(spec: string, root: string): string {
  if (LAYER_KEY_RE.test(spec)) return path.join(root, spec);
  return path.resolve(spec);
}

async function readRegular(file: string, maxBytes: number): Promise<Buffer> {
  // O_NOFOLLOW: симлинк вместо файла — ошибка, а не чтение чужого места
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new PresetFilesError(`${file}: символическая ссылка не допускается`, 'symlink');
    if (code === 'ENOENT') throw new PresetFilesError(`${file}: файла нет`, 'missing');
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new PresetFilesError(`${file}: не обычный файл`, 'not_file');
    if (st.size > maxBytes) throw new PresetFilesError(`${file}: размер ${st.size} больше ${maxBytes}`, 'too_big');
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

export async function loadLayers(specs: readonly string[], root: string = presetsRoot()): Promise<LoadedLayer[]> {
  if (specs.length === 0) throw new PresetFilesError('не указаны слои (--layers)');
  const out: LoadedLayer[] = [];
  for (const spec of specs) {
    const dir = layerDir(spec, root);
    const file = path.join(dir, 'preset.json');
    const text = (await readRegular(file, 5 * 1024 * 1024)).toString('utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new PresetFilesError(`${file}: не JSON (${(e as Error).message})`);
    }
    out.push({ spec, dir, layer: parseLayer(raw, file) });
  }
  return out;
}

export type PlannedAsset = { key: string; file: string; size: number };

/** Проверить `<слой>/assets/` каждого слоя; позднейший слой перекрывает одноимённый ассет. */
export async function planAssets(dirs: readonly string[]): Promise<PlannedAsset[]> {
  const byKey = new Map<string, PlannedAsset>();
  for (const dir of dirs) {
    const assets = path.join(dir, 'assets');
    let names: string[];
    try {
      names = await readdir(assets);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    for (const name of names.sort()) {
      const file = path.join(assets, name);
      if (!ASSET_NAME_RE.test(name) || name.includes('..')) throw new PresetFilesError(`ассет «${name}»: недопустимое имя`, 'bad_name');
      if (!ASSET_EXTENSIONS.some((ext) => name.endsWith(ext))) throw new PresetFilesError(`ассет «${name}»: расширение не из ${ASSET_EXTENSIONS.join(' ')}`, 'bad_ext');
      const buf = await readRegular(file, ASSET_MAX_BYTES); // симлинк, каталог, размер
      byKey.set(name, { key: name, file, size: buf.length });
    }
  }
  return [...byKey.values()];
}

/** Копирование в том ассетов: временный файл рядом и rename; одинаковый файл не трогаем. */
export async function installAssets(assets: readonly PlannedAsset[], target: string): Promise<{ copied: string[]; same: string[] }> {
  const copied: string[] = [];
  const same: string[] = [];
  if (assets.length === 0) return { copied, same };
  await mkdir(target, { recursive: true });
  for (const a of assets) {
    const data = await readRegular(a.file, ASSET_MAX_BYTES);
    const dest = path.join(target, a.key);
    try {
      const have = await readRegular(dest, ASSET_MAX_BYTES);
      if (have.equals(data)) {
        same.push(a.key);
        continue;
      }
    } catch (e) {
      // нет файла или он больше предела — перезаписываем; ссылка или каталог на месте ассета — ошибка
      if (!(e instanceof PresetFilesError) || (e.code !== 'missing' && e.code !== 'too_big')) throw e;
    }
    const tmp = path.join(target, `.${a.key}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    copied.push(a.key);
  }
  return { copied, same };
}

/** `theme.logo` должен ссылаться на существующий ассет: из плана копирования или уже в томе. */
export async function logoExists(logo: string, planned: readonly PlannedAsset[], target: string | undefined): Promise<boolean> {
  if (planned.some((a) => a.key === logo)) return true;
  if (!target || !ASSET_NAME_RE.test(logo)) return false;
  try {
    return (await stat(path.join(target, logo))).isFile();
  } catch {
    return false;
  }
}
