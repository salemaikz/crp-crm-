// Манифест изоляции сделок (B6, docs/deals-handoffs-design.md §5.3, §9): маршруты /api/deals/** и страницы
// сделки и формы покупки. Тела — синтетика; имён и номеров в них нет. За флагом PURCHASES (в прогоне включён).
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const OP_ID = '00000000-0000-4000-8000-0000000000d1';
const REQ_ID = '00000000-0000-4000-8000-0000000000d2';

/** Покупка, её правка и отмена, этап и проигрыш меняют сделку, ленту, карточку, задачи, передачу и колокол. */
const DEAL_TABLES = ['deals', 'client_events', 'cards', 'tasks', 'handoffs', 'notifications', 'notes', 'bookings', 'audit_log'] as const;
const DEAL = { name: 'id', entity: 'deal' } as const;

const entries: ManifestEntry[] = [
  // «Мои покупки»: отбор по заслуге (автор первой записи сделки); имя клиента — только при охвате его карточки
  { kind: 'route', path: '/api/deals/mine', method: 'GET', perm: 'deal.read', target: 'section', mutation: false },
  { kind: 'route', path: '/api/deals/[id]', method: 'GET', perm: 'deal.read', target: 'object', idParam: DEAL, mutation: false },
  // Карточка — в теле: раздел; чужая карточка — 404 от сервиса тем же телом
  {
    kind: 'route',
    path: '/api/deals/purchase',
    method: 'POST',
    perm: 'deal.purchase',
    target: 'section',
    sampleBody: { requestId: REQ_ID, cardId: 'cd-b-1', dealId: null, serviceTypeKey: 'master_group', amountKzt: 1000, wonDay: null },
    mutation: true,
    touches: DEAL_TABLES,
  },
  {
    kind: 'route',
    path: '/api/deals/[id]/purchase',
    method: 'PATCH',
    perm: 'deal.move_back',
    target: 'object',
    idParam: DEAL,
    sampleBody: { opId: OP_ID, version: 0, amountKzt: 1000 },
    mutation: true,
    touches: DEAL_TABLES,
  },
  {
    kind: 'route',
    path: '/api/deals/[id]/cancel-purchase',
    method: 'POST',
    perm: 'deal.move_back',
    target: 'object',
    idParam: DEAL,
    sampleBody: { opId: OP_ID, version: 0, mode: 'refund', comment: 'Синтетический комментарий' },
    mutation: true,
    touches: DEAL_TABLES,
  },
  {
    kind: 'route',
    path: '/api/deals/[id]/stage',
    method: 'POST',
    perm: 'deal.edit',
    target: 'object',
    idParam: DEAL,
    sampleBody: { opId: OP_ID, version: 0, stageKey: 'attended', nextStep: null },
    mutation: true,
    touches: DEAL_TABLES,
  },
  {
    kind: 'route',
    path: '/api/deals/[id]/lose',
    method: 'POST',
    perm: 'deal.edit',
    target: 'object',
    idParam: DEAL,
    sampleBody: { opId: OP_ID, version: 0, reasonCode: 'expensive', reasonText: '' },
    mutation: true,
    touches: DEAL_TABLES,
  },

  // --- страницы ---
  { kind: 'page', path: '/(mgr)/deals/[dealId]', method: 'GET', perm: 'deal.read', target: 'object', idParam: { name: 'dealId', entity: 'deal' }, mutation: false },
  {
    kind: 'page',
    path: '/(mgr)/deals/purchase/[cardId]',
    method: 'GET',
    perm: 'deal.purchase',
    target: 'object',
    idParam: { name: 'cardId', entity: 'card' },
    mutation: false,
  },
];

export default defineManifest('deals', entries);
