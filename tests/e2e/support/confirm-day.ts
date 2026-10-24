// День обзвона для e2e (calling-confirm.spec.ts): кладёт в активные настройки установки booking.confirmCall.weekdays = [1..7],
// чтобы каждый день был днём обзвона (код времени не подменяется). Повторный запуск безопасен. Запуск: `node --import tsx`.
import { loadCompatible } from '../../../src/server/platform/config/repo';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { getDb } from '../../../src/server/platform/db';
import { config as coreConfig } from '@crm/core';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL не задан');
process.env.DATABASE_URL = url;

const db = await getDb();
const [space] = await db.sql<{ id: string }>`SELECT id FROM spaces WHERE key = 'sales'`;
const gl = await loadCompatible(db.sql, 'global', coreConfig.CONFIG_SCHEMA_VERSION);
const sp = await loadCompatible(db.sql, space!.id, coreConfig.CONFIG_SCHEMA_VERSION);
if (!gl || !sp) throw new Error('нет ревизий настроек: prepareDb() не выполнен');
const spaceDoc = JSON.parse(JSON.stringify(sp.doc)) as { booking?: { confirmCall?: { weekdays: number[] } } };
const cc = spaceDoc.booking?.confirmCall;
if (!cc) throw new Error('в настройках нет booking.confirmCall');
const all = [1, 2, 3, 4, 5, 6, 7];
if (cc.weekdays.join(',') !== all.join(',')) {
  cc.weekdays = all;
  resetConfigCache();
  await writeConfig({ docs: { global: JSON.parse(JSON.stringify(gl.doc)) as never, spaces: { sales: spaceDoc as never } }, source: 'cli', authorId: null, note: 'e2e: обзвон каждый день' });
  console.log('e2e: обзвон включён на все дни');
} else console.log('e2e: обзвон уже на все дни');
process.exit(0);
