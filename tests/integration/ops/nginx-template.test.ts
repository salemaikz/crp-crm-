// Шаблон nginx (DEPLOY §3.1, D-032): статическая проверка того, что нельзя потерять при правках.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { patchNginxConf, proxyIncludeLine } from '../../../scripts/crmctl/secrets';
import type { Deps } from '../../../scripts/crmctl/types';

const tpl = readFileSync('deploy/nginx/crm.conf.template', 'utf8');

/** Тело `location ... { ... }` по началу заголовка. */
function block(src: string, head: string): string {
  const i = src.lastIndexOf(head); // для `location / {` нужен последний (проксирующий), не редирект порта 80
  assert.ok(i !== -1, `нет ${head}`);
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    if (src[k] === '}' && --depth === 0) return src.slice(open + 1, k);
  }
  throw new Error('не закрыт блок');
}

test('X-Via-Proxy выставляется в обоих проксирующих location (клиентский заголовок затирается)', () => {
  for (const head of ['location ^~ /api/ingest', 'location / {']) {
    assert.match(block(tpl, head), /proxy_set_header X-Via-Proxy 1;/, head);
  }
});

test('секрет доверенного прокси (D-155): include в обоих location вместе с X-Real-IP и X-Via-Proxy', () => {
  for (const head of ['location ^~ /api/ingest', 'location / {']) {
    const b = block(tpl, head);
    assert.match(b, /proxy_set_header X-Real-IP \$remote_addr;/, head);
    assert.match(b, /proxy_set_header X-Via-Proxy 1;\n(?:\s*#.*\n)*\s*include \/etc\/crm\/nginx-proxy\.d\/\*\.conf;/, head);
    // клиентский X-Real-IP/X-Forwarded-For затирается, а не дописывается
    assert.ok(!/proxy_add_x_forwarded_for/.test(b), head);
  }
  // маска, а не имя файла: до crmctl install файла нет, и nginx -t не должен падать
  assert.ok(!/include \/etc\/crm\/nginx-proxy\.d\/secret\.conf;/.test(tpl));
  // значения секрета в шаблоне нет, в журнал он не пишется
  assert.ok(!/X-Proxy-Secret\s+"/.test(tpl.replace(/#.*$/gm, '')), 'секрет не зашит в шаблон');
  const fmt = /log_format crm '([^']+)'/.exec(tpl)![1] as string;
  assert.ok(!/\$http_x_proxy_secret|\$http_/.test(fmt.replace('$http_user_agent', '')), 'в журнале нет заголовков, кроме User-Agent');
});

test('include шаблона совпадает с тем, что дописывает crmctl update; edge-профиль compose монтирует каталог секрета', () => {
  const deps = { paths: { etcDir: '/etc/crm' } } as unknown as Deps;
  assert.ok(tpl.includes(`        ${proxyIncludeLine(deps)}\n`));
  assert.equal(patchNginxConf(tpl, proxyIncludeLine(deps)).added, 0);
  const compose = readFileSync('deploy/compose/compose.yaml', 'utf8');
  assert.match(compose, /- \$\{CRM_NGINX_PROXY_DIR:-\/etc\/crm\/nginx-proxy\.d\}:\/etc\/crm\/nginx-proxy\.d:ro/);
});

test('/api/ingest закрыт снаружи при INGEST_PUBLIC != 1, в том числе без завершающего слэша', () => {
  const b = block(tpl, 'location ^~ /api/ingest');
  assert.match(b, /if \(\$ingest_public != "1"\) \{ return 404; \}/);
  assert.match(tpl, /set \$ingest_public "\$\{INGEST_PUBLIC\}";/);
});

test('журнал: путь /invite маскируется, query string и Referer не пишутся', () => {
  const map = block(tpl, 'map $uri $crm_log_uri');
  const rule = /~(\S+)\s+"([^"]+)"/.exec(map);
  assert.ok(rule, 'есть правило маски');
  const re = new RegExp(rule![1] as string);
  assert.ok(re.test('/invite'));
  assert.ok(re.test('/invite/abc123'));
  assert.ok(!re.test('/invitees'));
  assert.equal(rule![2], '/invite/***');
  const fmt = /log_format crm '([^']+)'/.exec(tpl)![1] as string;
  assert.match(fmt, /\$crm_log_uri/);
  assert.ok(!/\$request[^_]|\$args|\$query_string|\$http_referer|\$request_uri/.test(fmt), 'в журнале нет query string и Referer');
});

test('заголовки безопасности на уровне server, а страница обслуживания их не сбрасывает', () => {
  assert.match(tpl, /add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/);
  assert.match(tpl, /add_header Content-Security-Policy "default-src 'self'/);
  assert.match(tpl, /frame-ancestors 'none'/);
  const maint = block(tpl, 'location = /maintenance.html');
  assert.ok(!/add_header/.test(maint.replace(/#.*$/gm, '')), 'add_header в location сбросил бы заголовки server');
  assert.match(tpl, /error_page 502 503 504 \/maintenance\.html;/);
});

test('подстановки шаблона: хост, ingest и upstream — три переменные, как в envsubst compose и install.sh', () => {
  const vars = new Set([...tpl.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]));
  assert.deepEqual([...vars].sort(), ['CRM_DOMAIN', 'CRM_UPSTREAM', 'INGEST_PUBLIC']);
  const compose = readFileSync('deploy/compose/compose.yaml', 'utf8');
  assert.match(compose, /NGINX_ENVSUBST_FILTER: \^\(CRM_DOMAIN\|INGEST_PUBLIC\|CRM_UPSTREAM\)\$/);
  const sh = readFileSync('deploy/install.sh', 'utf8');
  assert.match(sh, /envsubst '\$\{CRM_DOMAIN\} \$\{INGEST_PUBLIC\} \$\{CRM_UPSTREAM\}'/);
});

test('install.sh: синтаксис bash, INGEST_PUBLIC=0 по умолчанию, sudo только на crmctl', () => {
  const r = spawnSync('bash', ['-n', 'deploy/install.sh']);
  assert.equal(r.status, 0, r.stderr.toString());
  const sh = readFileSync('deploy/install.sh', 'utf8');
  assert.match(sh, /INGEST_PUBLIC=0 CRM_UPSTREAM=127\.0\.0\.1:3100/);
  assert.match(sh, /NOPASSWD: \/usr\/local\/bin\/crmctl"/);
  assert.ok(!/NOPASSWD: ALL/.test(sh));
});
