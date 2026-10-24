// Поля для e2e ввода на месте (card-inline.spec.ts): в пресете клиента нет ни денежного поля клиента, ни текстового
// поля карточки, а оба пути (PATCH клиента и PATCH карточки) надо проверить. Добавляет в активные настройки установки
// e2e два поля с префиксом e2e_ (повторный запуск безопасен). Запуск: `node --import tsx` из спецификации.
import { loadCompatible } from '../../../src/server/platform/config/repo';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { getDb } from '../../../src/server/platform/db';
import { config as coreConfig } from '@crm/core';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL не задан');
process.env.DATABASE_URL = url;

const field = (key: string, object: 'client' | 'card', type: string, label: string) => ({
  key,
  object,
  type,
  label: { ru: label },
  options: [],
  access: { '*': 'read', operator: 'edit', rop: 'edit' },
  required: { always: false, onOutcome: [], onStage: [] },
  searchable: false,
  filterable: false,
  ingest: false,
  pii: 'none',
  showOn: { card: true, kanban: false, list: false },
});

const db = await getDb();
const [space] = await db.sql<{ id: string }>`SELECT id FROM spaces WHERE key = 'sales'`;
const gl = await loadCompatible(db.sql, 'global', coreConfig.CONFIG_SCHEMA_VERSION);
const sp = await loadCompatible(db.sql, space!.id, coreConfig.CONFIG_SCHEMA_VERSION);
if (!gl || !sp) throw new Error('нет ревизий настроек: prepareDb() не выполнен');
const globalDoc = JSON.parse(JSON.stringify(gl.doc)) as { fields: Array<{ key: string }> };
const spaceDoc = JSON.parse(JSON.stringify(sp.doc)) as { fields?: Array<{ key: string }> };
let changed = false;
if (!globalDoc.fields.some((f) => f.key === 'e2e_budget')) {
  globalDoc.fields.push(field('e2e_budget', 'client', 'money', 'Бюджет') as never);
  changed = true;
}
spaceDoc.fields ??= [];
if (!spaceDoc.fields.some((f) => f.key === 'e2e_plan')) {
  spaceDoc.fields.push(field('e2e_plan', 'card', 'text', 'План') as never);
  changed = true;
}
if (changed) {
  resetConfigCache();
  await writeConfig({ docs: { global: globalDoc as never, spaces: { sales: spaceDoc as never } }, source: 'cli', authorId: null, note: 'e2e: поля ввода на месте' });
}
console.log(changed ? 'e2e: поля добавлены' : 'e2e: поля уже есть');
process.exit(0);
