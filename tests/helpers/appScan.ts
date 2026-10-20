// Статический разбор src/** по AST TypeScript (не регулярками): какие route handler, страницы, layout и
// server actions есть и обёрнуты ли они в route/publicRoute/page/action из src/server/access.
// Используется статическими тестами (обёртки, покрытие манифеста) и раннером изоляции.
import { dirname, join, normalize, relative } from 'node:path';
import ts from 'typescript';
import { read, walk } from './sourceFiles';

export type WrapperName = 'route' | 'publicRoute' | 'page' | 'action';
export type Wrapper = { fn: WrapperName; perm?: string; target?: string; reason?: string; securityMutation?: boolean };
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type AppUnit = {
  kind: 'route' | 'page' | 'action';
  /** Файл от корня репозитория: src/app/api/x/route.ts */
  file: string;
  /** Имя экспорта: GET, default, имя server action. */
  exportName: string;
  method?: HttpMethod;
  /** Путь Next с группами: '/(auth)/login'; для layout — '<путь>/layout'; для action — '<файл от src/app>#<имя>'. */
  path: string;
  wrapped: Wrapper | null;
  /** page/layout: читает ли данные (по импортам и динамическим параметрам). Для остальных — true. */
  readsData: boolean;
  /** Почему считаем, что читает данные (для сообщения). */
  dataReason?: string;
  /** layout.tsx, а не page.tsx. */
  layout?: boolean;
};

/** Каталог app по умолчанию; самопроверка раннера подставляет свой (tests/isolation/fixtures/…/app). */
export const APP_DIR = 'src/app';

const WRAPPERS: readonly WrapperName[] = ['route', 'publicRoute', 'page', 'action'];
const METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

const kindOf = (file: string) => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kindOf(file));

/** Путь Next без групп `(g)`: '/(auth)/login' → '/login'; корень — '/'. */
export function stripGroups(p: string): string {
  const parts = p.split('/').filter((s) => s !== '' && !/^\(.*\)$/.test(s));
  return `/${parts.join('/')}`;
}

/** Модуль — ядро доступа (index или wrappers; относительный путь тоже учитывается). */
function isAccessSpec(file: string, spec: string): boolean {
  const target = spec.startsWith('@/') ? `src/${spec.slice(2)}` : spec.startsWith('.') ? normalize(join(dirname(file), spec)).split('\\').join('/') : spec;
  return target === 'src/server/access' || target === 'src/server/access/index' || target === 'src/server/access/wrappers';
}

type Bindings = { named: Map<string, WrapperName>; namespaces: Set<string> };

/** Локальные имена, привязанные к обёрткам доступа импортом (с учётом `as` и `import * as`). */
function wrapperBindings(sf: ts.SourceFile, file: string): Bindings {
  const named = new Map<string, WrapperName>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier) || !isAccessSpec(file, st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        const imported = (el.propertyName ?? el.name).text;
        if ((WRAPPERS as readonly string[]).includes(imported)) named.set(el.name.text, imported as WrapperName);
      }
    }
  }
  return { named, namespaces };
}

const unwrapExpr = (e: ts.Expression): ts.Expression => {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
  return cur;
};

const strProp = (obj: ts.ObjectLiteralExpression, name: string): string | undefined => {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === name) {
      const v = unwrapExpr(p.initializer);
      if (ts.isStringLiteralLike(v)) return v.text;
    }
  }
  return undefined;
};

/** Если выражение — вызов обёртки доступа, вернуть её описание. */
function wrapperOfCall(e: ts.Expression, b: Bindings): Wrapper | null {
  const call = unwrapExpr(e);
  if (!ts.isCallExpression(call)) return null;
  const callee = unwrapExpr(call.expression);
  let fn: WrapperName | undefined;
  if (ts.isIdentifier(callee)) fn = b.named.get(callee.text);
  else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && b.namespaces.has(callee.expression.text)) {
    if ((WRAPPERS as readonly string[]).includes(callee.name.text)) fn = callee.name.text as WrapperName;
  }
  if (!fn) return null;
  const first = call.arguments[0] && unwrapExpr(call.arguments[0]);
  const w: Wrapper = { fn };
  if (first && ts.isObjectLiteralExpression(first)) {
    const perm = strProp(first, 'perm');
    const target = strProp(first, 'target');
    const reason = strProp(first, 'reason');
    if (perm) w.perm = perm;
    if (target) w.target = target;
    if (reason) w.reason = reason;
    if (first.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'securityMutation')) w.securityMutation = true;
  }
  return w;
}

/** Верхнеуровневые объявления файла: имя → инициализатор / функция. */
function topLevelDecls(sf: ts.SourceFile): Map<string, ts.Expression | 'function'> {
  const m = new Map<string, ts.Expression | 'function'>();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) m.set(d.name.text, d.initializer);
    } else if (ts.isFunctionDeclaration(st) && st.name) m.set(st.name.text, 'function');
  }
  return m;
}

/** Выражение экспорта → обёртка (через локальные идентификаторы; циклы отсекаются). */
function resolveWrapper(e: ts.Expression | 'function' | undefined, b: Bindings, decls: Map<string, ts.Expression | 'function'>, seen = new Set<string>()): Wrapper | null {
  if (!e || e === 'function') return null;
  const direct = wrapperOfCall(e, b);
  if (direct) return direct;
  const u = unwrapExpr(e);
  if (ts.isIdentifier(u) && !seen.has(u.text)) {
    seen.add(u.text);
    return resolveWrapper(decls.get(u.text), b, decls, seen);
  }
  return null;
}

const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
const isExported = (n: ts.Node) => hasModifier(n, ts.SyntaxKind.ExportKeyword);
const isDefault = (n: ts.Node) => hasModifier(n, ts.SyntaxKind.DefaultKeyword);

type ExportEntry = { name: string; expr: ts.Expression | 'function' | undefined };

/** Значимые (не типовые) экспорты файла: имя → выражение для разбора обёртки. Реэкспорт из другого модуля — expr undefined. */
function valueExports(sf: ts.SourceFile): ExportEntry[] {
  const decls = topLevelDecls(sf);
  const out: ExportEntry[] = [];
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, expr: d.initializer });
        else out.push({ name: '<destructured>', expr: undefined });
      }
    } else if (ts.isFunctionDeclaration(st) && isExported(st)) {
      out.push({ name: isDefault(st) ? 'default' : (st.name?.text ?? 'default'), expr: 'function' });
    } else if (ts.isClassDeclaration(st) && isExported(st)) {
      out.push({ name: isDefault(st) ? 'default' : (st.name?.text ?? 'default'), expr: undefined });
    } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
      out.push({ name: 'default', expr: st.expression });
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      if (st.moduleSpecifier) {
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) if (!el.isTypeOnly) out.push({ name: el.name.text, expr: undefined });
        } else out.push({ name: '*', expr: undefined });
      } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          if (el.isTypeOnly) continue;
          out.push({ name: el.name.text, expr: decls.get((el.propertyName ?? el.name).text) ?? undefined });
        }
      }
    }
  }
  return out;
}

/** Файл Next в app: segments (с группами), тип. Приватные папки `_x` и слоты `@x` не маршруты. */
function appInfo(file: string, appDir = APP_DIR): { dir: string; base: string } | null {
  const rel = relative(appDir, file).split('\\').join('/');
  if (rel.startsWith('..')) return null;
  const parts = rel.split('/');
  const base = parts.pop() ?? '';
  if (parts.some((s) => s.startsWith('_') || s.startsWith('@'))) return null;
  return { dir: `/${parts.join('/')}`.replace(/\/$/, '') || '/', base };
}

export const isRouteFile = (file: string, appDir = APP_DIR) => /^route\.(ts|tsx|js|jsx)$/.test(appInfo(file, appDir)?.base ?? '');
export const isPageFile = (file: string, appDir = APP_DIR) => /^page\.(tsx|ts|jsx|js)$/.test(appInfo(file, appDir)?.base ?? '');
export const isLayoutFile = (file: string, appDir = APP_DIR) => /^layout\.(tsx|ts|jsx|js)$/.test(appInfo(file, appDir)?.base ?? '');

/** Директива в начале файла или тела функции. */
function hasDirective(statements: readonly ts.Statement[], text: string): boolean {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === text) return true;
  }
  return false;
}

export function analyzeRouteFile(file: string, source: string, appDir = APP_DIR): AppUnit[] {
  const sf = parse(file, source);
  const b = wrapperBindings(sf, file);
  const decls = topLevelDecls(sf);
  const dir = appInfo(file, appDir)?.dir ?? '/';
  const out: AppUnit[] = [];
  for (const ex of valueExports(sf)) {
    if (!(METHODS as readonly string[]).includes(ex.name)) continue;
    out.push({ kind: 'route', file, exportName: ex.name, method: ex.name as HttpMethod, path: dir, wrapped: resolveWrapper(ex.expr, b, decls), readsData: true });
  }
  return out;
}

/** Импорты, по которым страница считается читающей данные. */
function dataImport(file: string, sf: ts.SourceFile): string | undefined {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    if (st.importClause?.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    const target = spec.startsWith('@/') ? `src/${spec.slice(2)}` : spec.startsWith('.') ? normalize(join(dirname(file), spec)).split('\\').join('/') : spec;
    // сама обёртка — не чтение данных; всё остальное в src/server и БД — чтение
    if (isAccessSpec(file, spec)) continue;
    if (target === 'src/server' || target.startsWith('src/server/')) return spec;
    if (target === 'postgres' || target === 'next/headers') return spec;
  }
  return undefined;
}

/** Любой вызов fetch(...) — тоже чтение данных. */
function callsFetch(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch') found = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function analyzePageFile(file: string, source: string, appDir = APP_DIR): AppUnit[] {
  const sf = parse(file, source);
  const info = appInfo(file, appDir);
  if (!info) return [];
  const layout = isLayoutFile(file, appDir);
  const b = wrapperBindings(sf, file);
  const decls = topLevelDecls(sf);
  const ex = valueExports(sf).find((e) => e.name === 'default');
  const path = layout ? `${info.dir === '/' ? '' : info.dir}/layout` : info.dir;
  const client = hasDirective(sf.statements, 'use client');
  let reason: string | undefined;
  const imp = dataImport(file, sf);
  if (!client) {
    if (imp) reason = `импорт ${imp}`;
    else if (/\[[^\]]+\]/.test(info.dir)) reason = 'динамический параметр пути';
    else if (callsFetch(sf)) reason = 'вызов fetch';
  }
  const wrapped = ex ? resolveWrapper(ex.expr, b, decls) : null;
  const unit: AppUnit = { kind: 'page', file, exportName: 'default', method: 'GET', path, wrapped, readsData: reason !== undefined, ...(reason ? { dataReason: reason } : {}), ...(layout ? { layout: true } : {}) };
  return [unit];
}

/** Server actions: файл с 'use server' (каждый экспорт) и функции с 'use server' внутри тела. */
export function analyzeActionFile(file: string, source: string, appDir = APP_DIR): AppUnit[] {
  const sf = parse(file, source);
  const b = wrapperBindings(sf, file);
  const decls = topLevelDecls(sf);
  const out: AppUnit[] = [];
  const rel = relative(appDir, file).split('\\').join('/');
  const mk = (name: string, wrapped: Wrapper | null): AppUnit => ({ kind: 'action', file, exportName: name, path: `${rel}#${name}`, wrapped, readsData: true });
  if (hasDirective(sf.statements, 'use server')) {
    for (const ex of valueExports(sf)) out.push(mk(ex.name, resolveWrapper(ex.expr, b, decls)));
  }
  // Встроенные: function f() { 'use server'; ... } — обернуть action() нельзя, значит это нарушение
  const visit = (n: ts.Node): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.body && ts.isBlock(n.body) && hasDirective(n.body.statements, 'use server')) {
      const name = ts.isFunctionDeclaration(n) && n.name ? n.name.text : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : '<inline>';
      out.push(mk(`inline:${name}`, null));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Все единицы src/**: маршруты, страницы и layout, server actions. */
export function scanApp(srcDir = 'src'): AppUnit[] {
  const appDir = `${srcDir}/app`;
  const units: AppUnit[] = [];
  for (const file of walk(srcDir, ['.ts', '.tsx'])) {
    if (file.endsWith('.d.ts')) continue;
    const source = read(file);
    if (isRouteFile(file, appDir)) units.push(...analyzeRouteFile(file, source, appDir));
    else if (isPageFile(file, appDir) || isLayoutFile(file, appDir)) units.push(...analyzePageFile(file, source, appDir));
    // 'use server' может стоять в любом файле src — в том числе в странице
    if (source.includes('use server')) units.push(...analyzeActionFile(file, source, appDir));
  }
  return units;
}

/** Ключ единицы для сравнения с манифестом: 'METHOD /путь-без-групп' или action-путь. */
export function unitKey(u: Pick<AppUnit, 'kind' | 'method' | 'path'>): string {
  if (u.kind === 'action') return `POST ${u.path}`;
  return `${u.method ?? 'GET'} ${stripGroups(u.path)}`;
}
