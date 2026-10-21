// Том ассетов crm_assets на установке (D-334, D-333, docs/logo-design.md §2.6): статическая проверка поставки.
// app читает логотип из CRM_ASSETS_DIR; без тома и переменной в compose на установке клиента вместо логотипа был бы текст.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');
const compose = read('deploy', 'compose', 'compose.yaml');
const MOUNT = '/var/lib/crm/assets';

/** Блок сервиса из compose.yaml: от `  <имя>:` до следующего ключа того же уровня. Комментарии отброшены. */
function service(name: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start !== -1, `нет сервиса ${name}`);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(l) && !/^\s*#/.test(l)) break;
    if (!/^\s*#/.test(l)) out.push(l);
  }
  return out.join('\n');
}

test('app: том crm_assets только на чтение и CRM_ASSETS_DIR указывает на точку монтирования', () => {
  const app = service('app');
  assert.match(app, new RegExp(`^\\s+- crm_assets:${MOUNT}:ro$`, 'm'));
  assert.match(app, new RegExp(`^\\s+CRM_ASSETS_DIR: ${MOUNT}$`, 'm'));
  // свой список volumes заменяет список якоря: лицензия не должна пропасть
  assert.match(app, /- \$\{CRM_LICENSE_DIR:-\/var\/lib\/crm\/license\}:\/var\/lib\/crm\/license:ro/);
});

test('ctl: тот же образ, профиль tools, том на запись, только внутренняя сеть', () => {
  const ctl = service('ctl');
  assert.match(ctl, /<<: \*app-common/);
  assert.match(ctl, /profiles: \[tools\]/);
  assert.match(ctl, /restart: "no"/);
  assert.match(ctl, /entrypoint: \["node", "dist\/crmctl\.mjs"\]/);
  assert.match(ctl, new RegExp(`^\\s+- crm_assets:${MOUNT}$`, 'm'), 'ctl пишет в том: без :ro');
  assert.match(ctl, new RegExp(`^\\s+CRM_ASSETS_DIR: ${MOUNT}$`, 'm'));
  assert.match(ctl, /- \$\{CRM_LICENSE_DIR:-\/var\/lib\/crm\/license\}:\/var\/lib\/crm\/license:ro/);
  assert.match(ctl, /networks:\n\s+crm_internal: \{\}\n/);
  assert.ok(!/crm_egress|crm_ingest|ports:/.test(ctl), 'ctl без выхода наружу и без портов');
});

test('на запись том смонтирован только у ctl; worker, migrate, db и nginx его не видят', () => {
  for (const name of ['worker', 'migrate', 'db', 'nginx']) {
    assert.ok(!service(name).includes('crm_assets'), name);
  }
  const rw = [...compose.matchAll(new RegExp(`- crm_assets:${MOUNT}(:ro)?$`, 'gm'))].filter((m) => !m[1]);
  assert.equal(rw.length, 1, 'ровно одно монтирование на запись');
  // якорь x-app-common не монтирует ассеты: иначе их получили бы все сервисы образа
  const anchor = compose.slice(compose.indexOf('x-app-common:'), compose.indexOf('\nservices:'));
  assert.ok(!anchor.includes('crm_assets'));
});

test('том объявлен с постоянным именем, как crm_pg', () => {
  const vols = compose.slice(compose.lastIndexOf('\nvolumes:'));
  assert.match(vols, /\n  crm_assets:\n    name: crm_assets\n/);
});

test('Dockerfile: точка монтирования с владельцем node создаётся до USER node', () => {
  const df = read('Dockerfile');
  const runtime = df.slice(df.indexOf('AS runtime'));
  const mk = runtime.indexOf(`mkdir -p ${MOUNT} && chown node:node ${MOUNT}`);
  assert.ok(mk !== -1, 'нет mkdir/chown точки монтирования');
  assert.ok(mk < runtime.indexOf('\nUSER node'), 'каталог создаётся под root, до USER node');
});

test('app.env.example не задаёт CRM_ASSETS_DIR строкой (значение задаёт compose); .dockerignore закрывает stand-assets', () => {
  const env = read('deploy', 'compose', 'app.env.example');
  assert.doesNotMatch(env, /^CRM_ASSETS_DIR=/m);
  assert.match(env, /^# CRM_ASSETS_DIR=\/var\/lib\/crm\/assets$/m);
  assert.match(read('.dockerignore'), /^\/stand-assets\/$/m);
  assert.match(read('.gitignore'), /^\/stand-assets\/$/m);
});
