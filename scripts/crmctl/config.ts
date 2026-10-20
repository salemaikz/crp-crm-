// crmctl config: apply, diff, rollback, set, export (packages/core/src/config/README.md §3, CONFIG §4).
// Коды выхода: 0 — успех или нет изменений; 1 — ошибка; 2 — diff нашёл изменения;
// 3 — набор не прошёл проверку; 4 — ConfigConflictError.
// Запуск до реестра crmctl: tsx scripts/crmctl/config.ts <подкоманда> …
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONFIG_SCHEMA_VERSION,
  ConfigInvalidError,
  ConfigVersionError,
  GLOBAL_SCOPE,
  PresetLayerError,
  ConfigMergeError,
  assembleLayers,
  diffJson,
  formatDiff,
  formatPath,
  lastPresetDoc,
  migrateDoc,
  parsePath,
  presetUpdate,
  setAt,
  validateConfigSet,
  type ConfigChange,
  type Json,
  type JsonObject,
  type PresetUpdateResult,
} from '@crm/core/config';
import { getDb, openScriptDb } from '../../src/server/platform/db';
import { docOf, getActiveConfig, resetConfigCache } from '../../src/server/platform/config/active';
import { listRevisionHeads, listSpaces, loadCompatible, loadRevision } from '../../src/server/platform/config/repo';
import { installAssets, loadLayers, logoExists, planAssets, PresetFilesError, presetsRoot } from '../../src/server/platform/config/preset-files';
import { ConfigConflictError, writeConfig } from '../../src/server/platform/config/write';

export type Io = { out: (line: string) => void; err: (line: string) => void };

export type ConfigCtx = {
  io: Io;
  /** Открыть БД и вернуть закрытие. По умолчанию — openScriptDb (DATABASE_URL). */
  openDb: () => Promise<() => Promise<void>>;
  env: Record<string, string | undefined>;
  productVersion: () => Promise<string>;
  /** Только для тестов: вызывается после расчёта слияния и до записи (имитация правки из UI в этот момент). */
  beforeWrite?: () => Promise<void>;
};

const USAGE = `Использование: crmctl config <подкоманда>
  apply --layers <a>,<b>,… [--yes] [--force]   собрать слои и записать ревизии source=preset
  diff --layers <a>,<b>,…                       то же без записи; код 2, если есть изменения
  diff <область> <revA> <revB>                  дифф двух ревизий области
  rollback <область> <rev> [--yes]              новая ревизия с содержимым rev
  set <область> <путь> <json> [--yes]           точечная правка, source=cli
  export                                        документы global и пространств в JSON
Область: global или ключ пространства.`;

export type Parsed = { positional: string[]; flags: Map<string, string | true> };

/** Разбор аргументов: `--флаг`, `--флаг=значение`, `--layers a,b`; остальное — позиционные. */
export function parseArgs(argv: readonly string[], valueFlags: readonly string[] = ['layers']): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) flags.set(name, a.slice(eq + 1));
      else if (valueFlags.includes(name)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new UsageError(`флагу --${name} нужно значение`);
        flags.set(name, v);
        i++;
      } else flags.set(name, true);
    } else positional.push(a);
  }
  return { positional, flags };
}

class UsageError extends Error {
  override name = 'UsageError';
}

const KNOWN_FLAGS = new Set(['layers', 'yes', 'force']);

function checkFlags(p: Parsed): void {
  for (const f of p.flags.keys()) if (!KNOWN_FLAGS.has(f)) throw new UsageError(`неизвестный флаг --${f}`);
}

function layersOf(p: Parsed): string[] {
  const v = p.flags.get('layers');
  if (typeof v !== 'string' || v.trim() === '') throw new UsageError('нужен --layers <слой>,<слой>,…');
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

type Area = { name: string; id: string | null; kind: 'global' | 'space' };

/** Области установки: global и пространства из таблицы + ключи, которых там ещё нет (первая установка). */
async function areasOf(extraKeys: readonly string[]): Promise<Area[]> {
  const db = await getDb();
  const spaces = await listSpaces(db.sql);
  const out: Area[] = [{ name: GLOBAL_SCOPE, id: GLOBAL_SCOPE, kind: 'global' }, ...spaces.map((s) => ({ name: s.key, id: s.id, kind: 'space' as const }))];
  for (const k of extraKeys) if (!out.some((a) => a.name === k)) out.push({ name: k, id: null, kind: 'space' });
  return out;
}

async function currentOf(a: Area): Promise<{ rev: number; doc: JsonObject; presetBase: Json | undefined } | undefined> {
  if (a.id === null) return undefined;
  const db = await getDb();
  const r = await loadCompatible(db.sql, a.id, CONFIG_SCHEMA_VERSION);
  if (!r) return undefined;
  const heads = await listRevisionHeads(db.sql, a.id);
  return { rev: r.rev, doc: docOf(r, a.kind), presetBase: lastPresetDoc(heads) };
}

function printIssues(io: Io, e: ConfigInvalidError): void {
  io.err('Набор настроек не прошёл проверку:');
  for (const i of e.issues) io.err(`  ${i.path}: ${i.message}`);
}

function printUpdate(io: Io, area: string, current: JsonObject | undefined, doc: Json, res: PresetUpdateResult | null): ConfigChange[] {
  if (current === undefined) {
    io.out(`[${area}] новая область`);
    return [{ path: [], op: 'add', after: doc }];
  }
  const changes = diffJson(current, doc);
  if (changes.length === 0) io.out(`[${area}] без изменений`);
  else {
    io.out(`[${area}]`);
    for (const l of formatDiff(changes)) io.out(`  ${l}`);
  }
  if (res && res.kept.length > 0) {
    io.out(`[${area}] оставлено как у клиента (${res.kept.length}):`);
    for (const k of res.kept) io.out(`  ${formatPath(k.path)}: у клиента ${JSON.stringify(k.before)}, в пресете ${JSON.stringify(k.preset)}`);
  }
  if (res && res.forced.length > 0) {
    io.out(`[${area}] перезаписано --force (${res.forced.length}):`);
    for (const k of res.forced) io.out(`  ${formatPath(k.path)}: было ${JSON.stringify(k.before)}, стало ${JSON.stringify(k.after)}`);
  }
  return changes;
}

async function cmdApplyOrDiff(p: Parsed, ctx: ConfigCtx, mode: 'apply' | 'diff'): Promise<number> {
  const { io } = ctx;
  const yes = p.flags.get('yes') === true;
  const force = p.flags.get('force') === true;
  const root = presetsRoot(ctx.env);
  const loaded = await loadLayers(layersOf(p), root);
  const productVersion = await ctx.productVersion();
  const assembled = assembleLayers(
    loaded.map((l) => l.layer),
    { productVersion },
  );

  const set = validateConfigSet({ global: assembled.global, spaces: assembled.spaces });
  if (!set.ok) {
    printIssues(io, new ConfigInvalidError(set.issues));
    return 3;
  }

  // Ассеты накладки: проверка файлов до любой записи; логотип темы должен существовать
  const assets = await planAssets(loaded.map((l) => l.dir));
  const assetsDir = ctx.env.CRM_ASSETS_DIR?.trim() || undefined;
  const logo = set.value.global.theme.logo;
  if (!(await logoExists(logo, assets, assetsDir))) {
    io.err(`theme.logo «${logo}» не найден ни среди ассетов слоёв, ни в томе ассетов${assetsDir ? '' : ' (CRM_ASSETS_DIR не задан)'}`);
    return 1;
  }

  const areas = await areasOf(Object.keys(assembled.spaces));
  const docs: { global?: Json; spaces: Record<string, Json> } = { spaces: {} };
  const presetDocs: { global?: Json; spaces: Record<string, Json> } = { spaces: {} };
  // Ревизии, от которых считалось слияние: writeConfig сверит их под блокировкой записи (D-082)
  const expectedRev: Record<string, number> = {};
  let changed = 0;
  io.out(`Слои: ${assembled.layers.map((l) => `${l.key}@${l.version}`).join(', ')}`);
  for (const a of areas) {
    const next = a.kind === 'global' ? assembled.global : assembled.spaces[a.name];
    if (next === undefined) continue; // пространство есть в БД, но не в пресете — не трогаем
    const cur = await currentOf(a);
    expectedRev[a.name] = cur?.rev ?? 0;
    let doc: Json = next;
    let res: PresetUpdateResult | null = null;
    if (cur) {
      res = presetUpdate({ current: cur.doc, prevPreset: cur.presetBase, nextPreset: next, force });
      doc = res.doc;
    }
    const changes = printUpdate(io, a.name, cur?.doc, doc, res);
    if (changes.length > 0) changed++;
    if (a.kind === 'global') {
      docs.global = doc;
      presetDocs.global = next;
    } else {
      docs.spaces[a.name] = doc;
      presetDocs.spaces[a.name] = next;
    }
  }

  // Итог после слияния с правками клиента тоже обязан пройти проверку
  const finalSet = await finalCheck(docs, areas);
  if (finalSet) {
    printIssues(io, finalSet);
    return 3;
  }

  if (assets.length > 0) io.out(`Ассеты: ${assets.map((a) => a.key).join(', ')}`);
  if (mode === 'diff') return changed > 0 ? 2 : 0;
  if (!yes) {
    io.out('Запись не выполнена: добавьте --yes.');
    return 0;
  }
  if (assets.length > 0 && !assetsDir) {
    io.err('CRM_ASSETS_DIR не задан: некуда копировать ассеты слоёв');
    return 1;
  }
  await ctx.beforeWrite?.();
  // Сначала настройки: если запись отклонена (конфликт, проверка), том ассетов остаётся как был
  const res = await writeConfig({
    docs,
    presetDocs,
    source: 'preset',
    note: `layers: ${assembled.layers.map((l) => `${l.key}@${l.version}`).join(', ')}`,
    authorId: null,
    project: true,
    expectedRev,
  });
  // Копирование атомарно по файлам (временный файл и rename); повтор apply достроит недостающее
  if (assetsDir) {
    const r = await installAssets(assets, assetsDir);
    io.out(`Ассеты: скопировано ${r.copied.length}, без изменений ${r.same.length}`);
  }
  for (const w of res.written) io.out(`записано ${w.scope}: rev ${w.rev}`);
  if (res.unchanged.length > 0) io.out(`без изменений: ${res.unchanged.join(', ')}`);
  return 0;
}

/** Проверка набора «итоговые документы + области, которых нет в этом apply». */
async function finalCheck(docs: { global?: Json; spaces: Record<string, Json> }, areas: Area[]): Promise<ConfigInvalidError | null> {
  const spaces: Record<string, Json> = { ...docs.spaces };
  for (const a of areas) {
    if (a.kind === 'space' && spaces[a.name] === undefined) {
      const cur = await currentOf(a);
      if (cur) spaces[a.name] = cur.doc;
    }
  }
  const check = validateConfigSet({ global: docs.global, spaces });
  return check.ok ? null : new ConfigInvalidError(check.issues);
}

async function areaOf(name: string): Promise<Area> {
  const areas = await areasOf([]);
  const a = areas.find((x) => x.name === name);
  if (!a) throw new UsageError(`нет области «${name}» (global или ключ пространства)`);
  return a;
}

async function cmdDiffRevs(p: Parsed, ctx: ConfigCtx): Promise<number> {
  const [scope, a, b] = p.positional;
  const ra = Number(a);
  const rb = Number(b);
  if (!scope || !Number.isInteger(ra) || !Number.isInteger(rb)) throw new UsageError('diff <область> <revA> <revB>');
  const area = await areaOf(scope);
  const db = await getDb();
  const [x, y] = await Promise.all([loadRevision(db.sql, area.id as string, ra), loadRevision(db.sql, area.id as string, rb)]);
  if (!x || !y) {
    ctx.io.err(`нет ревизии ${!x ? ra : rb} области «${scope}»`);
    return 1;
  }
  const changes = diffJson(x.doc, y.doc);
  for (const l of formatDiff(changes)) ctx.io.out(l);
  if (changes.length === 0) ctx.io.out('без изменений');
  return changes.length > 0 ? 2 : 0;
}

async function cmdRollback(p: Parsed, ctx: ConfigCtx): Promise<number> {
  const [scope, revStr] = p.positional;
  const rev = Number(revStr);
  if (!scope || !Number.isInteger(rev) || rev < 1) throw new UsageError('rollback <область> <rev> [--yes]');
  const area = await areaOf(scope);
  const db = await getDb();
  const target = await loadRevision(db.sql, area.id as string, rev);
  if (!target) {
    ctx.io.err(`нет ревизии ${rev} области «${scope}»`);
    return 1;
  }
  if (target.schemaVersion > CONFIG_SCHEMA_VERSION) {
    ctx.io.err(`ревизия ${rev} записана схемой v${target.schemaVersion}, эта сборка знает v${CONFIG_SCHEMA_VERSION}: откат невозможен`);
    return 1;
  }
  const doc = target.schemaVersion < CONFIG_SCHEMA_VERSION ? migrateDoc(area.kind, target.doc as JsonObject, target.schemaVersion) : target.doc;
  const cur = await currentOf(area);
  const changes = diffJson(cur?.doc, doc);
  if (changes.length === 0) {
    ctx.io.out('Текущая ревизия уже совпадает с выбранной: нечего откатывать.');
    return 0;
  }
  for (const l of formatDiff(changes)) ctx.io.out(l);
  if (p.flags.get('yes') !== true) {
    ctx.io.out('Запись не выполнена: добавьте --yes.');
    return 0;
  }
  const res = await writeConfig({
    docs: area.kind === 'global' ? { global: doc } : { spaces: { [area.name]: doc } },
    source: 'rollback',
    note: `rollback to rev ${rev}`,
    authorId: null,
    ...(cur ? { expectedRev: { [area.name]: cur.rev } } : {}),
  });
  for (const w of res.written) ctx.io.out(`записано ${w.scope}: rev ${w.rev}`);
  return 0;
}

async function cmdSet(p: Parsed, ctx: ConfigCtx): Promise<number> {
  const [scope, pathStr, jsonStr] = p.positional;
  if (!scope || !pathStr || jsonStr === undefined) throw new UsageError('set <область> <путь> <json> [--yes]');
  let value: Json;
  try {
    value = JSON.parse(jsonStr) as Json;
  } catch (e) {
    throw new UsageError(`значение не JSON: ${(e as Error).message}`);
  }
  const area = await areaOf(scope);
  const cur = await currentOf(area);
  if (!cur) {
    ctx.io.err(`у области «${scope}» ещё нет ревизии: сначала config apply`);
    return 1;
  }
  const segs = parsePath(pathStr);
  const doc = setAt(cur.doc, segs, value);
  const changes = diffJson(cur.doc, doc);
  if (changes.length === 0) {
    ctx.io.out('без изменений');
    return 0;
  }
  for (const l of formatDiff(changes)) ctx.io.out(l);
  if (p.flags.get('yes') !== true) {
    ctx.io.out('Запись не выполнена: добавьте --yes.');
    return 0;
  }
  const res = await writeConfig({
    docs: area.kind === 'global' ? { global: doc } : { spaces: { [area.name]: doc } },
    source: 'cli',
    note: `set ${pathStr}`,
    authorId: null,
    expectedRev: { [area.name]: cur.rev },
  });
  for (const w of res.written) ctx.io.out(`записано ${w.scope}: rev ${w.rev}`);
  return 0;
}

async function cmdExport(ctx: ConfigCtx): Promise<number> {
  resetConfigCache();
  const cfg = await getActiveConfig();
  const out = { global: cfg.global.doc, spaces: Object.fromEntries(Object.entries(cfg.spaces).map(([k, v]) => [k, v.doc])) };
  ctx.io.out(JSON.stringify(out, null, 2));
  return 0;
}

export function defaultCtx(): ConfigCtx {
  return {
    io: { out: (l) => console.log(l), err: (l) => console.error(l) },
    openDb: openScriptDb,
    env: process.env,
    productVersion: async () => (JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version,
  };
}

export async function runConfig(argv: string[], ctx: ConfigCtx = defaultCtx()): Promise<number> {
  const { io } = ctx;
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    io.out(USAGE);
    return sub ? 0 : 1;
  }
  let close: (() => Promise<void>) | null = null;
  try {
    const p = parseArgs(rest);
    checkFlags(p);
    if (!['apply', 'diff', 'rollback', 'set', 'export'].includes(sub)) throw new UsageError(`неизвестная подкоманда «${sub}»`);
    close = await ctx.openDb();
    switch (sub) {
      case 'apply':
        return await cmdApplyOrDiff(p, ctx, 'apply');
      case 'diff':
        return p.flags.has('layers') ? await cmdApplyOrDiff(p, ctx, 'diff') : await cmdDiffRevs(p, ctx);
      case 'rollback':
        return await cmdRollback(p, ctx);
      case 'set':
        return await cmdSet(p, ctx);
      default:
        return await cmdExport(ctx);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 1;
    }
    if (e instanceof ConfigInvalidError) {
      printIssues(io, e);
      return 3;
    }
    if (e instanceof ConfigConflictError) {
      io.err(e.message);
      return 4;
    }
    if (e instanceof PresetLayerError || e instanceof ConfigMergeError || e instanceof PresetFilesError || e instanceof ConfigVersionError) {
      io.err(e.message);
      return 1;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    if (close) await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runConfig(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
