// Помощники интеграционных тестов приёма: синтетические настройки, ключи, запросы. Только синтетика (+7 709 …).
import type { Json } from '@crm/core/config';
import { minimalSet } from '@crm/core/config/testing/minimal';
import { systemActor } from '../../../src/server/access/systemActor';
import { createKey } from '../../../src/server/domain/intake';
import { handleDemand, handleLeads } from '../../../src/server/domain/intake';
import type { IngestScope } from '../../../src/server/domain/intake/types';
import { newId, type DbHandle } from '../../../src/server/platform/db';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';

export const T0 = Date.UTC(2026, 9, 21, 9, 0, 0); // среда 2026-10-21 09:00 UTC (пояс установки в тесте — UTC)

const t = (ru: string) => ({ ru });
const field = (key: string, pii: 'none' | 'person', searchable: boolean) => ({
  key,
  object: 'client',
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

/** Синтетические настройки: три источника приёма — с правилами (rules), открытый (open), краткий отчёт (brief). */
export function intakeDocs(): { global: Json; spaces: Record<string, Json> } {
  const s = minimalSet();
  const g = s.global as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- документ собирается по путям
  g.org.legalForms = [
    { key: 'too', label: t('ТОО'), aliases: ['ТОО', 'LLP', 'Товарищество с ограниченной ответственностью'], idIsPersonal: false },
    { key: 'ip', label: t('ИП'), aliases: ['ИП', 'Индивидуальный предприниматель'], idIsPersonal: true },
    { key: 'ao', label: t('АО'), aliases: ['АО'], idIsPersonal: false },
  ];
  g.org.idRule = 'kz_bin';
  g.org.personIdRule = 'kz_iin_hmac';
  g.phone = { country: 'KZ', mobilePrefixes: ['700', '701', '709'], reviewPrefixes: [], landlinePrefixes: ['71'] };
  const src = (key: string, o: Record<string, unknown>) => ({ key, label: t(`Источник ${key}`), kind: 'ingest', allowPersonNames: false, detailedReport: true, rejectRules: [], holdRules: [], ...o });
  g.sources = [
    ...g.sources,
    src('rules', { rejectRules: [{ code: 'legal_review', type: 'legalFormIn', values: ['ip'] }], holdRules: [{ code: 'region', type: 'regionNotIn', values: ['Центр'] }] }),
    src('open', {}),
    src('brief', { detailedReport: false, allowPersonNames: true }),
  ];
  g.fields = [field('okved', 'none', true), field('head_name', 'person', false)];
  return { global: s.global, spaces: s.spaces };
}

export async function installIntakeConfig(): Promise<void> {
  resetConfigCache();
  await writeConfig({ docs: intakeDocs(), source: 'cli', authorId: null, project: true, note: 'intake test' });
}

export async function mkUser(db: DbHandle, n: number): Promise<string> {
  const id = newId();
  await db.sql`INSERT INTO users (id, phone_digits, name, status, created_at) VALUES (${id}, ${`7701222${String(1000 + n)}`}, ${`Сотрудник ${n}`}, 'active', ${T0})`;
  return id;
}

export async function mkMember(db: DbHandle, userId: string, spaceId: string, o: { role?: string; inDistribution?: boolean; pausedOn?: string } = {}): Promise<void> {
  await db.sql`
    INSERT INTO memberships (user_id, space_id, role_key, in_distribution, paused_on, status, created_at, updated_at)
    VALUES (${userId}, ${spaceId}, ${o.role ?? 'manager'}, ${o.inDistribution ?? true}, ${o.pausedOn ?? ''}, 'active', ${T0}, ${T0})`;
}

export async function spaceIdOf(db: DbHandle, key = 'sales'): Promise<string> {
  const [r] = await db.sql<{ id: string }>`SELECT id FROM spaces WHERE key = ${key}`;
  if (!r) throw new Error(`нет пространства ${key}`);
  return r.id;
}

export async function mkKey(sourceKey: string, scopes: IngestScope[] = ['leads:write', 'leads:demand']): Promise<{ key: string; prefix: string }> {
  const { key, info } = await createKey(systemActor('test', T0), { spaceKey: 'sales', sourceKey, scopes, managed: 'cli' });
  return { key, prefix: info.prefix };
}

export function post(key: string | null, body: unknown, o: { headers?: Record<string, string>; raw?: string } = {}): Promise<Response> {
  return handleLeads(
    new Request('http://crm-app:3000/api/ingest/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...o.headers },
      body: o.raw ?? JSON.stringify(body),
    }),
  );
}

export function getDemand(key: string | null, headers: Record<string, string> = {}): Promise<Response> {
  return handleDemand(new Request('http://crm-app:3000/api/ingest/v1/demand', { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } }));
}

export const batch = (items: unknown[], batchId: string = newId()) => ({ batchId, items });

/** Синтетический номер +7 709 123 NNNN и его канон 7XXXXXXXXXX. */
export const ph = (n: number) => `+7 709 123 ${1000 + n}`;
export const digitsOf = (n: number) => `7709123${1000 + n}`;

export type Counts = { clients: number; phones: number; cards: number; sources: number; pairs: number; batches: number };

export async function counts(db: DbHandle): Promise<Counts> {
  const [r] = await db.sql<Counts>`
    SELECT (SELECT count(*)::int FROM clients) AS clients, (SELECT count(*)::int FROM client_phones) AS phones,
           (SELECT count(*)::int FROM cards) AS cards, (SELECT count(*)::int FROM client_sources) AS sources,
           (SELECT count(*)::int FROM dup_pairs) AS pairs, (SELECT count(*)::int FROM ingest_batches) AS batches`;
  return r as Counts;
}
