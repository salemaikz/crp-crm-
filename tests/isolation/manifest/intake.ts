// Манифест изоляции: приём лидов ingest/v1 (C3). Формат — tests/isolation/harness/manifest.ts.
// Оба маршрута публичные (сессии нет, доступ по ключу источника); прогон без ключа получает 401 и ничего не меняет.
import { defineManifest } from '../harness/manifest';

export default defineManifest('intake', [
  {
    kind: 'route',
    path: '/api/ingest/v1/leads',
    method: 'POST',
    perm: 'public',
    target: 'section',
    sampleBody: { batchId: '00000000-0000-4000-8000-000000000001', items: [{ externalId: 'synthetic-1', name: 'Синтетика ТОО', phones: ['+7 709 000 0001'] }] },
    mutation: true,
    touches: ['clients', 'client_phones', 'cards', 'client_sources', 'dup_pairs', 'ingest_batches'],
  },
  { kind: 'route', path: '/api/ingest/v1/demand', method: 'GET', perm: 'public', target: 'section', mutation: false },
]);
