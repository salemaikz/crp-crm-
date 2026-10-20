// Мир интеграционных тестов клиентов: синтетика изоляции + ревизия настроек с полями клиента и контакта.
// Поля подобраны под сценарии: правка, только чтение, скрытое от оператора, поиск, фильтр, ссылка.
import { minimalSet } from '@crm/core/config/testing/minimal';
import type { JsonObject } from '@crm/core/config';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { rolesLayer } from '../../isolation/harness/config';
import { SEED_TZ } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from '../access/world';

const t = (ru: string): JsonObject => ({ ru });

type FieldSpec = {
  key: string;
  object: 'client' | 'contact';
  type: string;
  access?: Record<string, string>;
  options?: Array<{ key: string; archived?: boolean }>;
  searchable?: boolean;
  filterable?: boolean;
  listed?: boolean;
};

function field(f: FieldSpec): JsonObject {
  return {
    key: f.key,
    object: f.object,
    type: f.type,
    label: t(`Поле ${f.key}`),
    options: (f.options ?? []).map((o) => ({ key: o.key, label: t(`Вариант ${o.key}`), ...(o.archived ? { archived: true } : {}) })),
    access: f.access ?? {},
    required: { always: false, onOutcome: [], onStage: [] },
    searchable: f.searchable ?? false,
    filterable: f.filterable ?? false,
    ingest: false,
    pii: 'none',
    showOn: { card: true, kanban: false, list: f.listed ?? false },
  };
}

/** Поля мира: segment — правка и поиск; industry — список с фильтром; credit — только чтение оператору; secret — скрыт от оператора. */
export const WORLD_FIELDS: JsonObject[] = [
  field({ key: 'segment', object: 'client', type: 'text', searchable: true, listed: true }),
  field({ key: 'industry', object: 'client', type: 'select', filterable: true, options: [{ key: 'trade' }, { key: 'service' }, { key: 'old', archived: true }] }),
  field({ key: 'tags', object: 'client', type: 'multiselect', filterable: true, options: [{ key: 'vip' }, { key: 'new' }] }),
  field({ key: 'credit', object: 'client', type: 'money', access: { '*': 'read', rop: 'edit' } }),
  field({ key: 'secret', object: 'client', type: 'text', searchable: true, filterable: true, access: { operator: 'hidden', '*': 'read' } }),
  field({ key: 'link', object: 'client', type: 'url' }),
  field({ key: 'mood', object: 'contact', type: 'text' }),
];

export function worldConfig(): { global: JsonObject; spaces: Record<string, JsonObject> } {
  const s = minimalSet();
  const g = s.global as Record<string, unknown>;
  const org = g.org as Record<string, unknown>;
  org.timezone = SEED_TZ;
  org.legalForms = [
    { key: 'llp', label: t('ТОО'), aliases: ['ТОО', 'Товарищество с ограниченной ответственностью'], idIsPersonal: false },
    { key: 'sole', label: t('ИП'), aliases: ['ИП', 'Индивидуальный предприниматель'], idIsPersonal: true },
  ];
  org.idRule = 'kz_bin';
  g.phone = { country: 'KZ', mobilePrefixes: ['70', '77'], reviewPrefixes: [], landlinePrefixes: ['71', '72'] };
  g.roles = rolesLayer('clients/crp');
  (g.team as Record<string, unknown>).fallbackOwnerRole = 'rop';
  g.fields = WORLD_FIELDS;
  const sp = s.spaces.sales as Record<string, unknown>;
  (sp.distribution as Record<string, unknown>).participantRoles = ['operator'];
  ((sp.distribution as Record<string, unknown>).inbound as Record<string, unknown>).offHours = 'rop';
  (sp.export as Record<string, unknown>).allowedRoles = ['rop'];
  (sp.handoff as Record<string, unknown>).alarmTo = ['rop'];
  ((sp.booking as Record<string, unknown>).duty as Record<string, unknown>).defaultRole = 'rop';
  return { global: s.global, spaces: s.spaces };
}

export async function openClientsWorld(): Promise<TestDb> {
  const db = await openWorld();
  resetConfigCache();
  await writeConfig({ docs: worldConfig(), source: 'cli', authorId: null, project: true, note: 'клиенты: мир тестов' });
  return db;
}

export async function closeClientsWorld(db: TestDb): Promise<void> {
  resetConfigCache();
  await closeWorld(db);
}
