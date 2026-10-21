// Манифест изоляции входящих передач (B6b, docs/deals-handoffs-design.md §7.2): маршруты /api/handoffs/** и
// страницы «Передачи». Чтение — `handoff.read` (глава отдела, исполнитель по отношениям; РОП и директор по роли),
// принять и отклонить — `handoff.accept`, назначить — `handoff.assign` (только глава отдела). За флагом PURCHASES.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const OP_ID = '00000000-0000-4000-8000-0000000000e1';
const HANDOFF = { name: 'id', entity: 'handoff' } as const;
const TABLES = ['handoffs', 'client_events', 'tasks', 'notifications', 'audit_log'] as const;

const entries: ManifestEntry[] = [
  { kind: 'route', path: '/api/handoffs', method: 'GET', perm: 'handoff.read', target: 'section', mutation: false },
  { kind: 'route', path: '/api/handoffs/[id]', method: 'GET', perm: 'handoff.read', target: 'object', idParam: HANDOFF, mutation: false },
  { kind: 'route', path: '/api/handoffs/[id]/members', method: 'GET', perm: 'handoff.assign', target: 'object', idParam: HANDOFF, mutation: false },
  {
    kind: 'route',
    path: '/api/handoffs/[id]/accept',
    method: 'POST',
    perm: 'handoff.accept',
    target: 'object',
    idParam: HANDOFF,
    sampleBody: { opId: OP_ID },
    mutation: true,
    touches: TABLES,
  },
  {
    kind: 'route',
    path: '/api/handoffs/[id]/decline',
    method: 'POST',
    perm: 'handoff.accept',
    target: 'object',
    idParam: HANDOFF,
    sampleBody: { opId: OP_ID, reason: 'Синтетическая причина' },
    mutation: true,
    touches: TABLES,
  },
  {
    kind: 'route',
    path: '/api/handoffs/[id]/assign',
    method: 'POST',
    perm: 'handoff.assign',
    target: 'object',
    idParam: HANDOFF,
    sampleBody: { opId: OP_ID, userId: 'u-mkt' },
    mutation: true,
    touches: TABLES,
  },

  // --- страницы ---
  { kind: 'page', path: '/(mgr)/handoffs', method: 'GET', perm: 'handoff.read', target: 'section', mutation: false },
  { kind: 'page', path: '/(mgr)/handoffs/[id]', method: 'GET', perm: 'handoff.read', target: 'object', idParam: HANDOFF, mutation: false },
];

export default defineManifest('handoffs', entries);
