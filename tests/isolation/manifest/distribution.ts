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
  // C6b: «Отсутствует», «Пауза», «Без владельца (не новые)». Отсутствие — не охватываемая сущность: раздел.
  { kind: 'route', path: `${API}/absences`, method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: `${API}/absences`,
    method: 'POST',
    perm: 'distribution.manage',
    target: 'section',
    sampleBody: { opId: OP_ID, userId: 'u-op-a', fromDay: '2026-10-28', toDay: '2026-10-30', substituteUserId: 'u-op-b' },
    mutation: true,
    touches: ['absences', 'cards', 'assign_log', 'client_events', 'notifications', 'audit_log'],
  },
  {
    kind: 'route',
    path: `${API}/absences/[id]/cancel`,
    method: 'POST',
    perm: 'distribution.manage',
    target: 'section',
    mutation: true,
    touches: ['absences', 'cards', 'assign_log', 'client_events', 'audit_log'],
  },
  // C9: «Предложены операторами» — разбор РОП
  { kind: 'route', path: `${API}/proposals`, method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: `${API}/proposals/[id]/resolve`,
    method: 'POST',
    perm: 'card.assign',
    target: 'section',
    sampleBody: { opId: OP_ID, decision: 'reject' },
    mutation: true,
    touches: ['proposals', 'clients', 'cards', 'assign_log', 'client_events', 'dup_pairs', 'audit_log'],
  },
  { kind: 'route', path: `${API}/ownerless`, method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: `${API}/ownerless/assign`,
    method: 'POST',
    perm: 'card.assign',
    target: 'section',
    sampleBody: { opId: OP_ID, toUserId: 'u-op-b', items: [{ cardId: 'cd-b-1', version: 0 }] },
    mutation: true,
    touches: ['cards', 'assign_log', 'client_events', 'notifications', 'audit_log'],
  },
  // B9b: спорные пары и слияние (за FEATURE_MERGE). Пара — не охватываемая сущность: раздел, стороны — по охвату.
  { kind: 'page', path: '/(mgr)/pairs', method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  { kind: 'route', path: `${API}/pairs`, method: 'GET', perm: 'pool.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: `${API}/pairs/[id]/resolve`,
    method: 'POST',
    perm: 'card.assign',
    target: 'section',
    sampleBody: { decision: 'split_allowed', comment: 'синтетика' },
    mutation: true,
    touches: ['dup_pairs', 'cards', 'audit_log'],
  },
  { kind: 'route', path: `${API}/pairs/[id]/merge-preview`, method: 'GET', perm: 'client.merge', target: 'section', mutation: false },
  {
    kind: 'route',
    path: `${API}/pairs/[id]/merge`,
    method: 'POST',
    perm: 'client.merge',
    target: 'section',
    sampleBody: { opId: OP_ID, survivor: 'a', owner: 'auto', fingerprint: '0'.repeat(64) },
    mutation: true,
    touches: ['clients', 'cards', 'client_phones', 'contacts', 'calls', 'deals', 'bookings', 'tasks', 'notes', 'dup_pairs', 'change_snapshots', 'client_events', 'audit_log'],
  },
];

export default defineManifest('distribution', entries);
