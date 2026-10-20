// Манифест изоляции импорта таблиц (C4, docs/import-design.md §10): все маршруты /api/import/** и обе страницы.
// Право одно — import.run (РОП, охват пространства). Оператор, администратор без роли и директор получают отказ
// на разделе; объект загрузки привязан к пространству (чужое = 404 тем же телом, это проверяет
// tests/integration/import/flow.test.ts). target = 'section': сущности `import` нет среди охватываемых
// сущностей прогона изоляции (ScopedEntity), поэтому записи с [id] описаны как разделы.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const base = { perm: 'import.run', target: 'section' } as const;
const WRITES = ['imports', 'import_rows', 'clients', 'client_phones', 'client_sources', 'cards', 'calls', 'assign_log', 'client_events', 'dup_pairs', 'tasks', 'stop_list', 'audit_log'] as const;
const FP = 'a'.repeat(64);

const entries: ManifestEntry[] = [
  { ...base, kind: 'page', path: '/(mgr)/import', method: 'GET', mutation: false },
  { ...base, kind: 'page', path: '/(mgr)/import/[id]', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: '/api/import', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: '/api/import/uploads', method: 'POST', sampleBody: {}, mutation: true, touches: ['imports', 'import_rows', 'audit_log'] },
  { ...base, kind: 'route', path: '/api/import/[id]', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: '/api/import/[id]/preview', method: 'POST', sampleBody: { ownerMap: {} }, mutation: true, touches: ['imports'] },
  { ...base, kind: 'route', path: '/api/import/[id]/rows', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: '/api/import/[id]/rows.csv', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: '/api/import/[id]/apply', method: 'POST', sampleBody: { fingerprint: FP, ownerMap: {} }, mutation: true, touches: WRITES },
];

export default defineManifest('import', entries);
