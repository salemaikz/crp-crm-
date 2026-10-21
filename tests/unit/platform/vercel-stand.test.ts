// Режим стенда на Vercel (D-318): когда включается, чем дополняет окружение, чему верит; вне режима — как прежде.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVercelStandDefaults, standPhoneRejected, vercelStandActive } from '../../../src/server/platform/stand';
import { DERIVED_SECRETS, deriveStandKey, driverDatabaseUrl, isVercelStand, vercelStandOverlay } from '../../../src/server/platform/stand/overlay';
import { configuredAppOrigin } from '../../../src/server/platform/stand/origin';
import { startupConfigProblems } from '../../../src/server/platform/env';
import { checkOrigin } from '../../../src/server/platform/auth/csrf';
import { sessionCookieSpec } from '../../../src/server/platform/auth/cookie';
import { UNKNOWN_IP, deriveClientIp, resetClientIpWarning } from '../../../src/server/platform/http/clientIp';
import { classifyRequest, ingestReachable } from '../../../src/server/platform/http/trustedProxy';
import { phoneHmac } from '../../../src/server/platform/hmac';
import { isFeatureEnabled } from '../../../src/server/platform/flags';
import { standImportBlocked } from '../../../src/server/domain/import/platformGlue';
import { buildDatabaseUrl, buildMode, stepEnv } from '../../../scripts/vercel/stand-env';

// Признак сборки стенда, который vercel-build вшивает в бандл; в tsx он читается из окружения процесса теста
process.env.CRM_VERCEL_STAND_BUILD = '1';

const GENERAL = { customer: null, standBuild: true };
const UNMARKED = { customer: null, standBuild: false };
const CLIENT = { customer: 'acme', standBuild: true };
const MASTER = 'synthetic-demo-master-secret-0123456789abcdef'; // синтетика, 45 символов
const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

/** Окружение стенда Vercel, как его видит функция до дополнения. */
const standEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: 'production',
  VERCEL: '1',
  VERCEL_ENV: 'production',
  CRM_STAND: '1',
  VERCEL_PROJECT_PRODUCTION_URL: 'stand-demo.vercel.app',
  DATABASE_URL: 'postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  CRM_DEMO_SECRET: MASTER,
  ...extra,
});

/** Окружение после дополнения (как после хука старта). */
const applied = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => {
  const e = standEnv(extra);
  applyVercelStandDefaults(e, GENERAL);
  return e;
};

afterEach(() => resetClientIpWarning());

test('режим включается только при VERCEL=1 и CRM_STAND=1 в общей сборке', () => {
  assert.equal(isVercelStand({ VERCEL: '1', CRM_STAND: '1' }, GENERAL), true);
  assert.equal(isVercelStand({ VERCEL: '1', CRM_STAND: '1' }, CLIENT), false);
  assert.equal(isVercelStand({ VERCEL: '1' }, GENERAL), false);
  assert.equal(isVercelStand({ CRM_STAND: '1' }, GENERAL), false);
  assert.equal(isVercelStand({ VERCEL: 'true', CRM_STAND: '1' }, GENERAL), false);
  assert.equal(isVercelStand({ VERCEL: '1', CRM_STAND: '0' }, GENERAL), false);
  // Общая сборка без признака vercel-build (npm run build, CRM_CORE_BUNDLE=1) режим не включает
  assert.equal(isVercelStand({ VERCEL: '1', CRM_STAND: '1' }, UNMARKED), false);
  // В тестах ядро — исходники без водяного знака: общая сборка
  assert.equal(vercelStandActive({ VERCEL: '1', CRM_STAND: '1' }), true);
});

test('APP_ORIGIN: явный не меняется, иначе https://<VERCEL_PROJECT_PRODUCTION_URL>', () => {
  assert.equal(vercelStandOverlay(standEnv()).set.APP_ORIGIN, 'https://stand-demo.vercel.app');
  assert.equal(vercelStandOverlay(standEnv({ APP_ORIGIN: 'https://crm.example.test' })).set.APP_ORIGIN, undefined);
  const bad = vercelStandOverlay(standEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'https://x.vercel.app/path' }));
  assert.equal(bad.set.APP_ORIGIN, undefined);
  assert.ok(bad.problems.some((p) => p.startsWith('APP_ORIGIN')));
  // Без режима адрес по умолчанию не появляется
  assert.equal(configuredAppOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'stand-demo.vercel.app' }), undefined);
  assert.equal(configuredAppOrigin({ VERCEL: '1', CRM_STAND: '1', VERCEL_PROJECT_PRODUCTION_URL: 'stand-demo.vercel.app' }), 'https://stand-demo.vercel.app');
});

test('секреты выводятся из CRM_DEMO_SECRET: разные метки — разные ключи, явные значения не трогаются', () => {
  const { set, problems } = vercelStandOverlay(standEnv());
  assert.deepEqual(problems, []);
  for (const name of Object.keys(DERIVED_SECRETS)) {
    assert.equal(set[name], deriveStandKey(MASTER, DERIVED_SECRETS[name] as string).toString('base64url'));
    assert.ok(Buffer.from(set[name] as string, 'base64url').length === 32, name);
  }
  assert.notEqual(set.CRM_PHONE_HMAC_KEY, set.CRM_IIN_HMAC_KEY);
  assert.equal(set.CRM_SECRETS_KID, 'stand');
  assert.equal(Buffer.from(set.CRM_SECRETS_KEY_stand as string, 'base64').length, 32);
  // Повтор даёт те же ключи (повторный деплой не ломает стоп-лист)
  assert.deepEqual(vercelStandOverlay(standEnv()).set, set);
  // Другой главный секрет — другие ключи
  assert.notEqual(vercelStandOverlay(standEnv({ CRM_DEMO_SECRET: `${MASTER}x` })).set.CRM_PHONE_HMAC_KEY, set.CRM_PHONE_HMAC_KEY);
  const explicit = vercelStandOverlay(standEnv({ CRM_PHONE_HMAC_KEY: 'explicit-key', CRM_SECRETS_KID: 'k1', CRM_SECRETS_KEY_k1: 'x' }));
  assert.equal(explicit.set.CRM_PHONE_HMAC_KEY, undefined);
  assert.equal(explicit.set.CRM_SECRETS_KID, undefined);
  assert.ok(explicit.set.CRM_IIN_HMAC_KEY);
});

test('без CRM_DEMO_SECRET или с коротким — понятная проблема; если все секреты заданы явно — он не нужен', () => {
  const none = vercelStandOverlay(standEnv({ CRM_DEMO_SECRET: undefined }));
  assert.ok(none.problems.some((p) => p.includes('CRM_DEMO_SECRET не задан') && p.includes('CRM_PHONE_HMAC_KEY')));
  assert.equal(none.set.CRM_PHONE_HMAC_KEY, undefined);
  const short = vercelStandOverlay(standEnv({ CRM_DEMO_SECRET: 'x'.repeat(31) }));
  assert.ok(short.problems.some((p) => p.includes('короче 32')));
  const allExplicit = vercelStandOverlay(standEnv({ CRM_DEMO_SECRET: undefined, CRM_PHONE_HMAC_KEY: 'a', CRM_IIN_HMAC_KEY: 'b' }));
  assert.deepEqual(allExplicit.problems, []);
  // Текст проблем не содержит значений
  for (const p of [...none.problems, ...short.problems]) assert.ok(!p.includes(MASTER) && !p.includes('xxxxxxxx'));
});

test('база: DATABASE_URL приоритетнее POSTGRES_URL, параметр только libpq убирается; пул маленький, без prepare', () => {
  assert.equal(vercelStandOverlay(standEnv()).set.DATABASE_URL, undefined);
  const pg = vercelStandOverlay(standEnv({ DATABASE_URL: undefined, POSTGRES_URL: 'postgres://u:p@h.example.test/db' }));
  assert.equal(pg.set.DATABASE_URL, 'postgres://u:p@h.example.test/db');
  const both = vercelStandOverlay(standEnv({ POSTGRES_URL: 'postgres://other@h.example.test/db' }));
  assert.equal(both.set.DATABASE_URL, undefined);
  const cb = vercelStandOverlay(standEnv({ DATABASE_URL: 'postgres://u:p@h.example.test/db?sslmode=require&channel_binding=require' }));
  assert.equal(cb.set.DATABASE_URL, 'postgres://u:p@h.example.test/db?sslmode=require');
  const none = vercelStandOverlay(standEnv({ DATABASE_URL: undefined }));
  assert.ok(none.problems.some((p) => p.includes('Neon')));
  const s = vercelStandOverlay(standEnv()).set;
  assert.equal(s.DB_PREPARE, '0');
  assert.equal(s.DB_POOL_MAX, '3');
  assert.equal(vercelStandOverlay(standEnv({ DB_POOL_MAX: '5', DB_PREPARE: '1' })).set.DB_POOL_MAX, undefined);
  assert.equal(driverDatabaseUrl('не url'), 'не url');
});

test('флаги стенда включены по умолчанию, явный 0 сохраняется; интеграции выключены всегда', () => {
  const e = applied({ FEATURE_KANBAN: '0', FEATURE_WAZZUP: '1' });
  for (const f of ['REPORTS', 'SALES_SETTINGS', 'BK_WIZARD', 'PURCHASES', 'MERGE', 'BULK_TRANSFER'] as const) assert.equal(isFeatureEnabled(f, e), true, f);
  assert.equal(isFeatureEnabled('KANBAN', e), false);
  assert.equal(isFeatureEnabled('WAZZUP', e), false);
  assert.equal(isFeatureEnabled('TELEPHONY_ZADARMA', e), false);
  assert.equal(isFeatureEnabled('TELEPHONY_BEELINE', e), false);
  assert.equal(isFeatureEnabled('IMPORT', e), false);
});

test('дополнение окружения: только в режиме; после него запуск проходит, HMAC — выведенным ключом', () => {
  const off = { NODE_ENV: 'production', VERCEL: '1' } as Record<string, string | undefined>;
  assert.deepEqual(applyVercelStandDefaults(off, GENERAL), { active: false, problems: [] });
  assert.deepEqual(Object.keys(off).sort(), ['NODE_ENV', 'VERCEL']);
  const client = standEnv();
  assert.equal(applyVercelStandDefaults(client, CLIENT).active, false);
  assert.equal(client.APP_ORIGIN, undefined);
  const e = applied();
  assert.deepEqual(startupConfigProblems(e, GENERAL), []);
  assert.equal(phoneHmac('77091000001', e), phoneHmac('77091000001', applied()));
  assert.notEqual(phoneHmac('77091000001', e), phoneHmac('77091000001', { NODE_ENV: 'test' }));
});

test('startupConfigProblems: вне режима требования production прежние', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u@h/db' };
  const p0 = startupConfigProblems(base, GENERAL);
  assert.ok(p0.some((p) => p.startsWith('APP_ORIGIN')));
  assert.ok(p0.some((p) => p.includes('CRM_PROXY_SECRET')));
  // VERCEL без CRM_STAND и CRM_STAND без VERCEL — не стенд
  for (const extra of [{ VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }, { CRM_STAND: '1' }]) {
    const p = startupConfigProblems({ ...base, ...extra }, GENERAL);
    assert.ok(p.some((x) => x.startsWith('APP_ORIGIN')), JSON.stringify(extra));
    assert.ok(p.some((x) => x.includes('CRM_PROXY_SECRET')), JSON.stringify(extra));
  }
});

test('startupConfigProblems: сборка клиента с VERCEL=1 и CRM_STAND=1 — отказ и прежние требования', () => {
  const p = startupConfigProblems(standEnv(), CLIENT);
  assert.ok(p.some((x) => x.includes('сборке клиента')));
  assert.ok(p.some((x) => x.includes('CRM_PROXY_SECRET')));
});

test('startupConfigProblems: сборка без признака стенда — прежние требования и подсказка', () => {
  const p = startupConfigProblems(standEnv(), UNMARKED);
  assert.ok(p.some((x) => x.includes('без признака стенда')));
  assert.ok(p.some((x) => x.includes('CRM_PROXY_SECRET')));
  const e = standEnv();
  assert.equal(applyVercelStandDefaults(e, UNMARKED).active, false);
  assert.equal(e.CRM_PHONE_HMAC_KEY, undefined);
});

test('startupConfigProblems в режиме: без CRM_DEMO_SECRET — отказ с подсказкой, CRM_PROXY_SECRET не нужен', () => {
  const e = standEnv({ CRM_DEMO_SECRET: undefined });
  applyVercelStandDefaults(e, GENERAL);
  const p = startupConfigProblems(e, GENERAL);
  assert.ok(p.some((x) => x.includes('CRM_DEMO_SECRET')));
  assert.ok(!p.some((x) => x.includes('CRM_PROXY_SECRET')));
});

test('IP клиента: в режиме — X-Real-IP или первый X-Forwarded-For; вне режима заголовки без секрета не читаются', () => {
  const e = applied();
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }), e, 0, GENERAL), '203.0.113.7');
  assert.equal(deriveClientIp(h({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }), e, 0, GENERAL), '198.51.100.1');
  assert.equal(deriveClientIp(h({ 'x-real-ip': 'не-ip' }), e, 0, GENERAL), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({}), e, 0, GENERAL), UNKNOWN_IP);
  // Та же среда в сборке клиента и без CRM_STAND — заголовкам не верим
  const quiet = (x: Record<string, string | undefined>) => ({ ...x, NODE_ENV: 'test' });
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7' }), quiet(e), 0, CLIENT), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7' }), quiet({ ...e, CRM_STAND: undefined }), 0, GENERAL), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7' }), quiet({ ...e, VERCEL: undefined }), 0, GENERAL), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7' }), quiet(e), 0, UNMARKED), UNKNOWN_IP);
});

test('приём лидов в режиме закрыт при любом INGEST_PUBLIC; запросы внешние', () => {
  const e = applied();
  assert.equal(classifyRequest(h({}), e, GENERAL), 'proxy');
  assert.equal(ingestReachable(h({}), e, GENERAL), false);
  assert.equal(ingestReachable(h({}), { ...e, INGEST_PUBLIC: '1' }, GENERAL), false);
  // Вне режима — как раньше: прямой запрос без меток доходит
  assert.equal(ingestReachable(h({}), { ...e, INGEST_PUBLIC: '1' }, UNMARKED), true);
  // Вне режима прямой запрос без меток — внутренний, как раньше
  assert.equal(classifyRequest(h({}), { ...e, CRM_STAND: undefined }, GENERAL), 'direct');
  assert.equal(classifyRequest(h({}), e, CLIENT), 'direct');
});

test('CSRF и cookie на стенде: адрес проекта, cookie __Host- по https', () => {
  const env = { NODE_ENV: 'production', VERCEL: '1', CRM_STAND: '1', VERCEL_PROJECT_PRODUCTION_URL: 'stand-demo.vercel.app' };
  assert.equal(checkOrigin(h({ origin: 'https://stand-demo.vercel.app' }), env), 'ok');
  assert.equal(checkOrigin(h({ origin: 'https://evil.example.test' }), env), 'mismatch');
  assert.equal(checkOrigin(h({ origin: 'https://stand-demo.vercel.app' }), { ...env, CRM_STAND: undefined }), 'mismatch');
  assert.equal(sessionCookieSpec(env).name, '__Host-crm_sid');
  // Без признака сборки стенда адрес по умолчанию не появляется
  assert.equal(configuredAppOrigin(env, false), undefined);
  process.env.CRM_VERCEL_STAND_BUILD = '0';
  try {
    assert.equal(checkOrigin(h({ origin: 'https://stand-demo.vercel.app' }), env), 'mismatch');
  } finally {
    process.env.CRM_VERCEL_STAND_BUILD = '1';
  }
});

test('импорт файлов на стенде Vercel закрыт, вне режима — нет', () => {
  assert.equal(standImportBlocked(applied()), true);
  assert.equal(standImportBlocked({ ...applied(), CRM_STAND: undefined }), false);
  assert.equal(standImportBlocked({ NODE_ENV: 'production' }), false);
});

test('номера на стенде: только блок +7 709; вне режима — любые', () => {
  const e = applied();
  assert.equal(standPhoneRejected('77091000004', e, GENERAL), false);
  assert.equal(standPhoneRejected('77015550123', e, GENERAL), true);
  assert.equal(standPhoneRejected('77015550123', e, UNMARKED), false);
  assert.equal(standPhoneRejected('77015550123', e, CLIENT), false);
  assert.equal(standPhoneRejected('77015550123', { NODE_ENV: 'production' }, GENERAL), false);
});

test('режим сборки: stand только в Production, preview — без миграций и сида', () => {
  assert.equal(buildMode(standEnv()), 'stand');
  assert.equal(buildMode(standEnv({ VERCEL_ENV: 'preview' })), 'preview');
  assert.equal(buildMode(standEnv({ VERCEL_ENV: undefined })), 'preview');
  assert.equal(buildMode(standEnv({ CRM_STAND: undefined })), 'off');
  assert.equal(buildMode(standEnv({ CRM_CUSTOMER_ID: 'acme' })), 'off');
  const pr = stepEnv(standEnv({ VERCEL_ENV: 'preview' }));
  assert.ok('problems' in pr && pr.problems.some((x) => x.includes('только в Production')));
});

test('шаги сборки: прямой адрес Neon той же базы, NODE_ENV=production, клиентская сборка — отказ', () => {
  const pooled = 'postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';
  const direct = 'postgres://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
  assert.equal(buildDatabaseUrl({ DATABASE_URL_UNPOOLED: direct }, pooled), 'postgres://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require');
  assert.equal(buildDatabaseUrl({ DATABASE_URL_UNPOOLED: 'postgres://u:p@other.example.test/neondb' }, pooled), pooled);
  assert.equal(buildDatabaseUrl({}, pooled), pooled);
  const r = stepEnv(standEnv({ NODE_ENV: undefined, DATABASE_URL_UNPOOLED: direct }));
  assert.ok('env' in r);
  if ('env' in r) {
    assert.equal(r.env.NODE_ENV, 'production');
    assert.equal(r.env.CRM_VERCEL_STAND_BUILD, '1');
    assert.equal(r.env.MIGRATE_DATABASE_URL, r.env.DATABASE_URL);
    assert.ok(r.env.DATABASE_URL?.includes('ep-x.eu-central-1'));
    assert.ok(r.env.CRM_PHONE_HMAC_KEY);
  }
  assert.ok('problems' in stepEnv(standEnv({ CRM_CUSTOMER_ID: 'acme' })));
  assert.ok('problems' in stepEnv(standEnv({ CRM_DEMO_SECRET: undefined })));
  assert.ok('problems' in stepEnv({ VERCEL: '1' }));
});

test('стенд: CRM_ASSETS_DIR всегда stand-assets, даже если задан другой (D-333)', () => {
  assert.equal(vercelStandOverlay(standEnv()).set.CRM_ASSETS_DIR, 'stand-assets');
  assert.equal(vercelStandOverlay(standEnv({ CRM_ASSETS_DIR: '/var/lib/crm/assets' })).set.CRM_ASSETS_DIR, 'stand-assets');
  assert.equal(vercelStandOverlay(standEnv({ CRM_ASSETS_DIR: 'stand-assets' })).set.CRM_ASSETS_DIR, undefined);
});
