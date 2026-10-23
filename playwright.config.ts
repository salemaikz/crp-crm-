import { tmpdir } from 'node:os';
import path from 'node:path';
import { devices, defineConfig } from '@playwright/test';
import { generateVapidKeys } from './src/server/platform/push/vapid';

// E2E на собранном приложении (`next start`). Два мобильных проекта: iPhone 13 (WebKit) и Pixel 7 (Chromium).
// E2E_PORT — для параллельных прогонов из разных рабочих копий.
// Каталог ассетов (логотип, D-333): prepare-db копирует туда ассеты накладки, сервер отдаёт файл оттуда же.
// Задаётся до defineConfig, чтобы его видели и воркеры тестов, и сервер.
process.env.CRM_ASSETS_DIR ||= path.join(tmpdir(), `crm-e2e-assets-${process.env.E2E_PORT || 3100}`);
// Доска оператора (OP_BOARD) и новое окно «Перезвон» (CALLBACK_V2) за флагами (D-335…D-347). По умолчанию выключены, как
// в бою: основной прогон проверяет прежнее поведение. Сценарии доски и перезвона идут отдельным прогоном с
// FEATURE_OP_BOARD=1 FEATURE_CALLBACK_V2=1 (tests/e2e/calling-board, calling-callback, shell-menu; см. e2e.yml).
process.env.FEATURE_OP_BOARD ||= '0';
process.env.FEATURE_CALLBACK_V2 ||= '0';
const PORT = Number(process.env.E2E_PORT) || 3100;
const isCI = !!process.env.CI;
// Одноразовая пара VAPID для e2e: push на стенде включён, ключ нигде не хранится (P8b)
const vapid = generateVapidKeys();

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'ru-RU',
    timezoneId: 'Asia/Almaty',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'iphone-13', use: { ...devices['iPhone 13'] } },
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // PW_SKIP_BUILD=1 — сборка уже сделана отдельным шагом (CI)
    command: process.env.PW_SKIP_BUILD ? `npm run start -- -p ${PORT}` : `npm run build && npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !isCI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // next start — это production: APP_ORIGIN (иначе 403 на мутации, D-153) и CRM_PROXY_SECRET (иначе отказ
    // запуска, D-155). Секрет — синтетика для e2e; запросы браузера идут мимо nginx, IP у всех «unknown».
    env: {
      APP_ORIGIN: `http://localhost:${PORT}`,
      CRM_ASSETS_DIR: process.env.CRM_ASSETS_DIR,
      CRM_PROXY_SECRET: process.env.CRM_PROXY_SECRET || 'e2e-proxy-secret-synthetic-not-for-production',
      // Ключи HMAC номеров и ИИН: в production без них итог звонка отвечает 500 (fail closed). Только синтетика.
      CRM_PHONE_HMAC_KEY: process.env.CRM_PHONE_HMAC_KEY || 'e2e-phone-hmac-key-synthetic-not-for-production',
      // Канбан (B8) в production выключен по умолчанию; на стенде и в e2e включён
      FEATURE_KANBAN: process.env.FEATURE_KANBAN || '1',
      CRM_IIN_HMAC_KEY: process.env.CRM_IIN_HMAC_KEY || 'e2e-iin-hmac-key-synthetic-not-for-production',
      // e2e идёт как стенд: флаги модулей, чьи экраны проверяются, включены (D-047, D-295; в production без значения — выкл)
      FEATURE_REPORTS: process.env.FEATURE_REPORTS || '1',
      FEATURE_SALES_SETTINGS: process.env.FEATURE_SALES_SETTINGS || '1',
      // Подбор консультанта, график и «Мои консультации» (B5b/B5c) за флагом; в production без него выключены
      FEATURE_BK_WIZARD: '1',
      // Покупки и передачи в отдел (B6/B6b) за флагом
      FEATURE_PURCHASES: '1',
      // Импорт таблиц и профиль «Записи» (C4, C4b) за флагами; на бою выключены до приёмки
      FEATURE_IMPORT: '1',
      FEATURE_IMPORT_BOOKINGS: '1',
      FEATURE_OP_BOARD: process.env.FEATURE_OP_BOARD,
      FEATURE_CALLBACK_V2: process.env.FEATURE_CALLBACK_V2,
      // Тёмная тема и переключатель (D-342) за флагом; FEATURE_THEME_DARK=0 проверяет прежнее поведение без флага
      FEATURE_THEME_DARK: process.env.FEATURE_THEME_DARK || '1',
      // Web-push (P8b): флаг и одноразовые ключи; переключатель и отметку решения клиента спецификация ставит в БД
      FEATURE_PUSH: '1',
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:e2e@example.invalid',
    },
  },
});
