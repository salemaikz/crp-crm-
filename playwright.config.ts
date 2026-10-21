import { devices, defineConfig } from '@playwright/test';

// E2E на собранном приложении (`next start`). Два мобильных проекта: iPhone 13 (WebKit) и Pixel 7 (Chromium).
// E2E_PORT — для параллельных прогонов из разных рабочих копий.
const PORT = Number(process.env.E2E_PORT) || 3100;
const isCI = !!process.env.CI;

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
      CRM_PROXY_SECRET: process.env.CRM_PROXY_SECRET || 'e2e-proxy-secret-synthetic-not-for-production',
      // Ключи HMAC номеров и ИИН: в production без них итог звонка отвечает 500 (fail closed). Только синтетика.
      CRM_PHONE_HMAC_KEY: process.env.CRM_PHONE_HMAC_KEY || 'e2e-phone-hmac-key-synthetic-not-for-production',
      CRM_IIN_HMAC_KEY: process.env.CRM_IIN_HMAC_KEY || 'e2e-iin-hmac-key-synthetic-not-for-production',
      // Подбор консультанта, график и «Мои консультации» (B5b/B5c) за флагом; в production без него выключены
      FEATURE_BK_WIZARD: '1',
      // Покупки и передачи в отдел (B6/B6b) за флагом
      FEATURE_PURCHASES: '1',
    },
  },
});
