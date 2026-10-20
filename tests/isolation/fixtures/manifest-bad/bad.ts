import { defineManifest } from '../../harness/manifest';

const card = { name: 'id', entity: 'card' } as const;
const event = { name: 'id', entity: 'event' } as const;
export default defineManifest('bad', [
  { kind: 'route', path: '/api/leaky/[id]', method: 'GET', perm: 'card.read', target: 'object', idParam: card, mutation: false },
  { kind: 'route', path: '/api/oracle/[id]', method: 'GET', perm: 'card.read', target: 'object', idParam: card, mutation: false },
  { kind: 'route', path: '/api/leaky-write/[id]', method: 'PATCH', perm: 'card.edit', target: 'object', idParam: card, mutation: true, touches: ['cards'] },
  { kind: 'route', path: '/api/leaky-guests/[id]', method: 'GET', perm: 'booking.read', target: 'object', idParam: event, mutation: false, shared: { ownerSees: true } },
  { kind: 'page', path: '/(op)/leaky/[id]', method: 'GET', perm: 'card.read', target: 'object', idParam: card, mutation: false },
]);
