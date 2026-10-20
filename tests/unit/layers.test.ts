// Слои кода (D-011, ARCHITECTURE §2.1–2.2): обход импортов. Дополняет ESLint no-restricted-imports:
// понимает относительные пути и директиву 'use client'. Нарушение роняет CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';
import { read, walk } from '../helpers/sourceFiles';

const CODE = ['.ts', '.tsx', '.mjs'] as const;
/** names — импортируемые имена; '*' — все (namespace, export *, import(), require()). */
type Imp = { spec: string; typeOnly: boolean; names: string[] };

/** Все зависимости файла через TypeScript API: import/export from (в т.ч. многострочные), import(), require(). */
// Вид разбора — по расширению: в .ts приведение <T>x разбирается как JSX и прячет хвост файла.
const kindOf = (fileName: string) => (fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

export function importsOf(source: string, fileName = 'x.tsx'): Imp[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kindOf(fileName));
  const out: Imp[] = [];
  const lit = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const spec = lit(n.moduleSpecifier);
      if (spec) out.push({ spec, typeOnly: n.importClause?.isTypeOnly === true, names: importNames(n.importClause) });
    } else if (ts.isExportDeclaration(n)) {
      const spec = lit(n.moduleSpecifier);
      const names =
        n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : ['*'];
      if (spec) out.push({ spec, typeOnly: n.isTypeOnly, names });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = lit(n.moduleReference.expression);
      if (spec) out.push({ spec, typeOnly: n.isTypeOnly, names: ['*'] });
    } else if (ts.isCallExpression(n)) {
      const isDyn = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isReq = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      const spec = (isDyn || isReq) && n.arguments.length > 0 ? lit(n.arguments[0]) : undefined;
      if (spec) out.push({ spec, typeOnly: false, names: ['*'] });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Имена из import-клаузы: default, именованные (исходное имя, не алиас), '*' для namespace. */
function importNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push('default');
  const b = clause.namedBindings;
  if (b && ts.isNamespaceImport(b)) names.push('*');
  if (b && ts.isNamedImports(b)) for (const e of b.elements) names.push((e.propertyName ?? e.name).text);
  return names;
}

/** Директива 'use client' среди начальных директив файла (после "use strict" и комментариев тоже). */
export function isClientFile(source: string, fileName = 'x.tsx'): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kindOf(fileName));
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === 'use client') return true;
  }
  return false;
}

/** Спецификатор → путь от корня репозитория без расширения (для @/, @crm/core и относительных) или сам пакет. */
function resolveSpec(file: string, spec: string): string {
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
  if (spec === '@crm/core' || spec.startsWith('@crm/core/')) return `packages/core/src${spec.slice('@crm/core'.length)}`;
  if (spec.startsWith('.')) return normalize(join(dirname(file), spec)).split('\\').join('/');
  return spec;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const isNext = (s: string) => /^next(-intl)?($|\/)/.test(s);

type Violation = string;

/** Правила слоёв для одного файла. */
export function checkFile(file: string, source: string): Violation[] {
  const v: Violation[] = [];
  const imps = importsOf(source, file);
  const client = isClientFile(source, file);
  for (const { spec, typeOnly, names } of imps) {
    const target = resolveSpec(file, spec);
    const bad = (why: string) => v.push(`${file}: import '${spec}' — ${why}`);

    // Ядро — packages/core/src; packages/core/build.mjs — инструмент сборки (D-101), ему ФС можно
    if (under(file, 'packages/core/src')) {
      if (isNext(spec) || /^react(-dom)?($|\/)/.test(spec) || spec === 'postgres' || /^(node:)?fs($|\/)/.test(spec)) bad('ядро без Next, React, БД и ФС');
      if (under(target, 'src')) bad('ядро не импортирует src/**');
    }
    if (under(file, 'src/server/platform') && !under(file, 'src/server/platform/http')) {
      if (isNext(spec)) bad('платформа без Next (кроме platform/http)');
    }
    if (under(file, 'src/server/platform')) {
      if (under(target, 'src/server/domain') || under(target, 'src/integrations') || under(target, 'src/app') || under(target, 'src/ui')) {
        bad('платформа не импортирует домен, интеграции и интерфейс');
      }
    }
    if (under(file, 'src/server/domain')) {
      if (isNext(spec)) bad('домен без Next');
      if (under(target, 'src/app') || under(target, 'src/ui')) bad('домен не импортирует интерфейс');
      if (under(target, 'src/integrations') && target !== 'src/integrations/contract') bad('домен видит только интеграционный contract');
    }
    if (under(file, 'src/server/access')) {
      if (under(target, 'src/app') || under(target, 'src/ui') || under(target, 'src/integrations')) bad('доступ не импортирует интерфейс и интеграции');
    }
    if (under(file, 'src/integrations')) {
      if (under(target, 'src/server/domain') || under(target, 'src/app') || under(target, 'src/ui')) bad('интеграции не импортируют домен и интерфейс');
      const plugin = /^src\/integrations\/(telephony|messenger)\//.exec(file)?.[1];
      const other = /^src\/integrations\/(telephony|messenger)(\/|$)/.exec(target)?.[1];
      if (plugin && other && plugin !== other) bad('плагины не импортируют друг друга');
    }
    if (under(file, 'src/app') || under(file, 'src/ui')) {
      if (spec === 'postgres' || under(target, 'src/server/platform/db')) bad('SQL и БД — только в репозиториях домена');
      if (/^src\/server\/domain\/[^/]+\/repo(\.|$)/.test(target)) bad('репозитории домена недоступны интерфейсу');
    }
    // SystemActor — только в scripts/**, src/server/jobs/** (а в домене и доступе — как тип)
    if (target === 'src/server/access/systemActor') {
      const ok =
        under(file, 'scripts') || under(file, 'src/server/jobs') || under(file, 'src/server/access') || (under(file, 'src/server/domain') && typeOnly) || under(file, 'tests');
      if (!ok) bad('SystemActor разрешён только в scripts/** и src/server/jobs/**');
    }
    if (target === 'src/server/access/scope' && !(under(file, 'src/server/access') || under(file, 'src/server/domain') || under(file, 'tests'))) {
      bad('scopeSql выдаёт только src/server/access, использует домен');
    }
    // Внутренности доступа (подмена сессии/часов, сырой SQL охвата, реестр исполнителей) — только тесты и сам доступ
    const outsideAccess = !under(file, 'src/server/access') && !under(file, 'tests');
    if (/^src\/server\/access\/(testing|sqlFrag|registry)$/.test(target) && outsideAccess) {
      bad('access/testing, access/sqlFrag и access/registry недоступны вне src/server/access и тестов');
    }
    // assembleViewer регистрирует исполнителя любой формы (в обход buildViewer/systemActor) — тоже внутренность
    if (target === 'src/server/access/viewer' && outsideAccess && (names.includes('assembleViewer') || names.includes('*'))) {
      bad('assembleViewer недоступен вне src/server/access и тестов');
    }
    // Клиентский компонент не получает ядро и сервер
    if (client && (under(target, 'packages/core') || under(target, 'src/server'))) bad("файл с 'use client' не импортирует ядро и src/server/**");
  }
  return v;
}

test('слои кода соблюдены', () => {
  const files = [...walk('packages', CODE), ...walk('src', CODE), ...walk('scripts', CODE)].filter((f) => !f.endsWith('.test.ts'));
  assert.ok(files.length > 0);
  const violations = files.flatMap((f) => checkFile(f, read(f)));
  assert.deepEqual(violations, []);
});

test('проверка слоёв ловит нарушения (самопроверка правил)', () => {
  assert.equal(checkFile('packages/core/src/a.ts', "import postgres from 'postgres';").length, 1);
  assert.equal(checkFile('packages/core/src/a.ts', "import { x } from '../../../src/server/platform/env';").length, 1);
  assert.equal(checkFile('packages/core/src/a.ts', "import { z } from 'zod'; import { y } from './b';").length, 0);
  assert.equal(checkFile('packages/core/build.mjs', "import { writeFileSync } from 'node:fs';").length, 0);
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import { NextResponse } from 'next/server';").length, 1);
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import type { SystemActor } from '@/server/access/systemActor';").length, 0);
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import { SystemActor } from '@/server/access/systemActor';").length, 1);
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import { scopeSql } from '@/server/access/scope';").length, 0);
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import { p } from '@/integrations/wazzup';").length, 1);
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import type { C } from '@/integrations/contract';").length, 0);
  assert.equal(checkFile('src/server/platform/x.ts', "import { d } from '@/server/domain/clients/repo';").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "import { getDb } from '@/server/platform/db';").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "import { SystemActor } from '@/server/access/systemActor';").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "import { scopeSql } from '@/server/access/scope';").length, 1);
  assert.equal(checkFile('src/ui/Card.tsx', "'use client';\nimport { x } from '@crm/core';").length, 1);
  assert.equal(checkFile('src/ui/Card.tsx', "import { x } from '@crm/core';").length, 0);
  assert.equal(checkFile('src/integrations/telephony/zadarma/index.ts', "import { m } from '../../messenger/wazzup';").length, 1);
  assert.equal(checkFile('scripts/worker.ts', "import { SystemActor } from '../src/server/access/systemActor';").length, 0);
  // Многострочные и скрытые формы импорта
  assert.equal(checkFile('src/app/page.tsx', "import {\n  getDb,\n} from '@/server/platform/db';").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "export {\n  getDb,\n} from '@/server/platform/db';").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "const m = await import(\n  '@/server/platform/db'\n);").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "const m = require('@/server/platform/db');").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "import db = require('@/server/platform/db');").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "// import { x } from '@/server/platform/db';\nconst s = \"import x from '@/server/platform/db'\";").length, 0);
  assert.equal(checkFile('src/ui/C.tsx', "'use client';\nimport {\n  a,\n} from '@/server/domain/x';").length, 1);
  assert.equal(checkFile('src/ui/C.tsx', "\"use strict\";\n'use client';\nimport { a } from '@/server/platform/env';").length, 1);
  assert.equal(checkFile('src/ui/C.tsx', "/* c */\n// d\n'use client'\nconst a = require('@/server/platform/env');").length, 1);
  assert.equal(checkFile('src/ui/C.tsx', "import { a } from '@/server/platform/env';").length, 0);
  assert.equal(checkFile('src/integrations/telephony/z/i.ts', "import {\n  x,\n} from '@/server/domain/calls';").length, 1);
  assert.equal(checkFile('src/integrations/telephony/z/i.ts', "import { S } from '@/server/access/systemActor';").length, 1);
  // Внутренности доступа закрыты для src/**, открыты тестам и самому доступу
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import { signInForTests } from '@/server/access/testing';").length, 1);
  assert.equal(checkFile('src/server/domain/clients/repo.ts', "import { x } from '../../access/sqlFrag';").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "import { assertIssued } from '@/server/access/registry';").length, 1);
  assert.equal(checkFile('src/app/page.tsx', "const m = await import('@/server/access/testing');").length, 1);
  assert.equal(checkFile('src/server/platform/x.ts', "import type { T } from '@/server/access/testing';").length, 1);
  assert.equal(checkFile('src/server/access/scope.ts', "import { x } from './sqlFrag';").length, 0);
  assert.equal(checkFile('src/server/access/viewer.ts', "import { registerActor } from './registry';").length, 0);
  // Регистрация исполнителя в обход buildViewer/systemActor: registerActor и assembleViewer
  assert.equal(checkFile('src/server/domain/x/service.ts', "import { registerActor } from '@/server/access/registry';").length, 1);
  assert.equal(checkFile('scripts/crmctl/x.ts', "import { registerActor } from '../../src/server/access/registry';").length, 1);
  assert.equal(checkFile('src/server/domain/x/service.ts', "import { assembleViewer } from '@/server/access/viewer';").length, 1);
  assert.equal(checkFile('src/server/domain/x/service.ts', "import { assembleViewer as a } from '../../access/viewer';").length, 1);
  assert.equal(checkFile('src/server/domain/x/service.ts', "import * as v from '@/server/access/viewer';").length, 1);
  assert.equal(checkFile('src/server/domain/x/service.ts', "export { assembleViewer } from '@/server/access/viewer';").length, 1);
  assert.equal(checkFile('scripts/x.ts', "const v = await import('../src/server/access/viewer');").length, 1);
  assert.equal(checkFile('src/server/domain/x/service.ts', "import { parseAccessConfig, assertNotSelf } from '@/server/access/viewer';").length, 0);
  assert.equal(checkFile('src/server/access/testing.ts', "import { assembleViewer } from './viewer';").length, 0);
  assert.equal(checkFile('tests/unit/x.test.ts', "import { assembleViewer } from '../../src/server/access/viewer';").length, 0);
  assert.equal(checkFile('tests/integration/access/world.ts', "import { resetAccessForTests } from '../../../src/server/access/testing';").length, 0);
  assert.equal(checkFile('src/app/page.tsx', "import { page } from '@/server/access';").length, 0);
  // В .ts приведение <T>x не должно прятать импорты после себя
  assert.equal(checkFile('src/app/x.ts', "const a = <any>foo;\nconst m = require('@/server/platform/db');").length, 1);
  assert.equal(checkFile('src/app/x.ts', "function f<T>(x: T) { return <T>x; }\nexport { getDb } from '@/server/platform/db';").length, 1);
});
