// Манифест изоляции раздачи (C6a): все маршруты /api/distribution/** (docs/distribution-design.md §6) и экран РОП.
// Это разделы (target = 'section'): сотрудники и пул — не охватываемые сущности; оператор без `pool.read`,
// `card.assign` и `distribution.manage` получает 403, гость — 401. Тела — синтетика.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const OP_ID = '00000000-0000-4000-8000-0000000000c1';
const API = '/api/distribution';

const entries: ManifestEntry[] = [
  { kind: 'page', path: '/(mgr)/distribution', method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  { kind: 'route', path: `${API}/pool`, method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  { kind: 'route', path: `${API}/participants`, method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: `${API}/participants/[userId]`,
    method: 'PUT',
    perm: 'distribution.manage',
    target: 'section',
    sampleBody: { inDistribution: true },
    mutation: true,
    touches: ['memberships', 'audit_log'],
  },
  {
    kind: 'route',
    path: `${API}/issue`,
    method: 'POST',
    perm: 'card.assign',
    target: 'section',
    sampleBody: { opId: OP_ID, toUserId: 'u-op-b', count: 1 },
    mutation: true,
    touches: ['cards', 'assign_log', 'client_events', 'notifications', 'audit_log'],
  },
  { kind: 'route', path: `${API}/log`, method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
];

export default defineManifest('distribution', entries);
