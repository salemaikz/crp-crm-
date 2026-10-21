// Подготовка БД e2e (запускается из сценариев как `node --import tsx`): миграции и настройки пресета, если их ещё нет.
// БД — E2E_DATABASE_URL, та же, что DATABASE_URL запущенного сервера. Повторный запуск безопасен.
// Синтетика: сотрудников и карточки сценарий создаёт сам.
import path from 'node:path';
import { openDriver } from '../../../src/server/platform/db';
import { migrate } from '../../../src/server/platform/db/migrate';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL не задан');
process.env.DATABASE_URL = url;

const driver = await openDriver(url);
let hasConfig = false;
try {
  await migrate(driver);
  const heads = await driver.sql<{ n: number }>`SELECT count(*)::int AS n FROM config_revisions`;
  hasConfig = (heads[0]?.n ?? 0) > 0;
} finally {
  await driver.close();
}
if (!hasConfig) {
  const { applySeedConfig } = await import('../../isolation/harness/config');
  await applySeedConfig();
}
// Ассеты накладки в том (логотип, D-333): как `crmctl config apply`; без каталога логотипа в шапке не будет
const assetsDir = process.env.CRM_ASSETS_DIR?.trim();
if (assetsDir) {
  const { installAssets, planAssets } = await import('../../../src/server/platform/config/preset-files');
  const { SEED_LAYERS } = await import('../../isolation/harness/config');
  const root = path.join(import.meta.dirname, '..', '..', '..', 'presets');
  const dirs = SEED_LAYERS.map((l) => (path.isAbsolute(l) ? l : path.join(root, l)));
  await installAssets(await planAssets(dirs), assetsDir);
}
console.log('e2e: база готова');
process.exit(0);
