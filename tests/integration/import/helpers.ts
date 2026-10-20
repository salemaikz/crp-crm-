// Помощники интеграционных тестов импорта: синтетические настройки, сотрудники, загрузка файлов.
// Только синтетика (+7 709 …). Профиль «диапазон строк → оператор» в схему настроек пока не ложится,
// поэтому слоты и fieldTargets подставляются через overrideImportContextForTests.
import { imports } from '@crm/core';
import type { Json } from '@crm/core/config';
import { minimalSet } from '@crm/core/config/testing/minimal';
import { generateSyntheticSheets } from '../../../packages/core/src/import/syntheticSheets';
import { overrideImportContextForTests, loadImportContextFromConfig } from '../../../src/server/domain/import/settings';
import { importService, type ImportActor } from '../../../src/server/domain/import';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { newId, type DbHandle } from '../../../src/server/platform/db';

export const T0 = Date.UTC(2026, 9, 21, 9, 0, 0); // среда 2026-10-21 09:00 UTC (пояс установки в тесте — UTC)
export const SNAPSHOT = '2026-10-20';
export const PROFILE = 'operator_tables';

const t = (ru: string) => ({ ru });
const textField = (key: string, object: 'client' | 'card', pii: 'none' | 'person', searchable: boolean) => ({
  key,
  object,
  type: 'text',
  label: t(key),
  options: [],
  access: { '*': 'edit' },
  required: { always: false, onOutcome: [], onStage: [] },
  searchable,
  filterable: false,
  ingest: true,
  pii,
  showOn: { card: false, kanban: false, list: false },
});

export const SYSTEM_COLUMNS = {
  Тип: 'legalForm',
  Наименование: 'name',
  Регион: 'region',
  Руководитель: 'head',
  ОКЭД: 'activity',
  Телефон: 'phones',
  Адрес: 'address',
  ИИН: 'orgId',
  'ЛПР подтвержден': 'lpr',
  Ответ: 'outcome',
  Статус: 'status',
  'Точная ниша': 'niche',
  Заметка: 'note',
};

/** Настройки установки для импорта: две формы, источник import с правилом «ИП на разбор юриста», профиль. */
export function importDocs(): { global: Json; spaces: Record<string, Json> } {
  const s = minimalSet();
  const g = s.global as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- документ собирается по путям
  g.org.legalForms = [
    { key: 'too', label: t('ТОО'), aliases: ['ТОО', 'Товарищество с ограниченной ответственностью'], idIsPersonal: false },
    { key: 'ip', label: t('ИП'), aliases: ['ИП', 'Индивидуальный предприниматель'], idIsPersonal: true },
    { key: 'ao', label: t('АО'), aliases: ['АО'], idIsPersonal: false },
  ];
  g.org.idRule = 'kz_bin';
  g.org.personIdRule = 'kz_iin_hmac';
  g.phone = {
    country: 'KZ',
    mobilePrefixes: ['700', '701', '702', '705', '707', '708', '709', '747', '775', '776', '777', '778'],
    reviewPrefixes: ['770', '774'],
    landlinePrefixes: ['71', '72'],
  };
  g.sources = [
    ...g.sources,
    { key: 'import', label: t('Импорт таблиц'), kind: 'import', allowPersonNames: true, detailedReport: false, rejectRules: [], holdRules: [{ code: 'legal_review', type: 'legalFormIn', values: ['ip'] }] },
  ];
  g.fields = [textField('head_name', 'client', 'person', false), textField('okved', 'client', 'none', true)];
  const sp = s.spaces.sales as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  sp.fields = [textField('niche', 'card', 'none', false)];
  const aliases: Record<string, string[]> = {
    no_answer: ['Отключен/Не берет'],
    callback: ['Перезвонить'],
    bad_number: ['Недоступен', 'Не имеет отношение'],
    not_target: ['Закрылся'],
    not_interested: ['Не интересует'],
    do_not_call: ['Полный отказ'],
    agreed: ['Подтвержден'],
  };
  for (const o of sp.calling.outcomes) o.importAliases = aliases[o.key] ?? [];
  sp.import.profiles = [
    {
      key: PROFILE,
      label: t('Таблицы операторов'),
      columns: SYSTEM_COLUMNS,
      valueMaps: { outcome: {}, lpr: { да: true, нет: false }, target: { целевой: true, 'не целевой': false } },
      ownerBy: 'row_ranges',
      outcomePriority: ['do_not_call', 'not_target', 'agreed', 'not_interested', 'bad_number', 'callback', 'no_answer'],
      snapshotDate: null,
    },
  ];
  return { global: g as Json, spaces: { sales: sp as Json } };
}

export async function installImportConfig(): Promise<void> {
  resetConfigCache();
  await writeConfig({ docs: importDocs(), source: 'cli', authorId: null, project: true, note: 'import test' });
}

export async function spaceIdOf(db: DbHandle, key = 'sales'): Promise<string> {
  const [r] = await db.sql<{ id: string }>`SELECT id FROM spaces WHERE key = ${key}`;
  if (!r) throw new Error(`нет пространства ${key}`);
  return r.id;
}

export async function mkUser(db: DbHandle, n: number, name = `Сотрудник ${n}`): Promise<string> {
  const id = newId();
  await db.sql`INSERT INTO users (id, phone_digits, name, status, created_at) VALUES (${id}, ${`7701333${String(1000 + n)}`}, ${name}, 'active', ${T0})`;
  return id;
}

export async function mkMember(db: DbHandle, userId: string, spaceId: string, role = 'manager'): Promise<void> {
  await db.sql`
    INSERT INTO memberships (user_id, space_id, role_key, in_distribution, paused_on, status, created_at, updated_at)
    VALUES (${userId}, ${spaceId}, ${role}, TRUE, '', 'active', ${T0}, ${T0})`;
}

export interface World {
  spaceId: string;
  lead: ImportActor;
  /** Ярлык слота → id учётки оператора. */
  ownerMap: Record<string, string>;
  sheets: ReturnType<typeof generateSyntheticSheets>;
}

/** Синтетический мир: настройки, РОП, операторы под слоты генератора, подмена профиля со слотами. */
export async function makeWorld(db: DbHandle, rows = 2200, seed = 7, slotsOverride?: imports.OperatorSlot[]): Promise<World> {
  process.env.FEATURE_IMPORT = '1';
  await installImportConfig();
  const spaceId = await spaceIdOf(db);
  const generated = generateSyntheticSheets({ rows, seed });
  const sheets = slotsOverride ? { ...generated, slots: slotsOverride } : generated;
  const leadId = await mkUser(db, 0, 'Руководитель Синтетик');
  await mkMember(db, leadId, spaceId, 'lead');
  const ownerMap: Record<string, string> = {};
  let n = 1;
  for (const slot of sheets.slots) {
    const id = await mkUser(db, n, `Оператор ${n}`);
    await mkMember(db, id, spaceId, 'manager');
    ownerMap[slot.label] = id;
    n++;
  }
  overrideImportContextForTests(async (sid) => {
    const base = await loadImportContextFromConfig(sid);
    return {
      ...base,
      settings: {
        ...base.settings,
        profiles: base.settings.profiles.map((p) => ({
          ...p,
          ownerBy: { kind: 'row_ranges', slots: sheets.slots },
          fieldTargets: { head: { object: 'client', fieldKey: 'head_name' }, activity: { object: 'client', fieldKey: 'okved' }, niche: { object: 'card', fieldKey: 'niche' } },
        })),
      },
    };
  });
  return { spaceId, lead: { userId: leadId, spaceId }, ownerMap, sheets };
}

/** Основная таблица генератора → CSV (баннер, заголовки, данные; колонка «ИИН» добавлена к ИП). */
export function mainCsv(sheets: World['sheets'], mutate?: (grid: string[][]) => void): Buffer {
  const grid = sheets.main.map((r) => [...r]);
  grid[1]!.push('ИИН');
  mutate?.(grid);
  return Buffer.from(imports.toCsv(grid, ';'), 'utf-8');
}

export const upload = (actor: ImportActor, body: Buffer | Uint8Array, over: { profileKey?: string; sheet?: string | number; now?: number; fileName?: string } = {}) =>
  importService.upload(actor, { profileKey: over.profileKey ?? PROFILE, snapshotDay: SNAPSHOT, fileName: over.fileName ?? 'журнал.csv', body, ...(over.sheet !== undefined ? { sheet: over.sheet } : {}) }, over.now ?? T0);

export type Counts = Record<string, number>;

/** Снимок бизнес-таблиц (без самих загрузок и аудита): повторный импорт обязан его не менять. */
export async function snapshot(db: DbHandle): Promise<Counts> {
  const [r] = await db.sql<Counts>`
    SELECT (SELECT count(*)::int FROM clients) AS clients, (SELECT count(*)::int FROM client_phones) AS phones,
           (SELECT count(*)::int FROM cards) AS cards, (SELECT count(*)::int FROM calls) AS calls,
           (SELECT count(*)::int FROM client_sources) AS sources, (SELECT count(*)::int FROM client_events) AS events,
           (SELECT count(*)::int FROM assign_log) AS assigns, (SELECT count(*)::int FROM dup_pairs) AS pairs,
           (SELECT count(*)::int FROM tasks) AS tasks, (SELECT count(*)::int FROM stop_list) AS stop,
           (SELECT coalesce(sum(version),0)::int FROM cards) AS versions`;
  return r as Counts;
}

