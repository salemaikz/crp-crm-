import { defineManifest } from '../../harness/manifest';

const card = { name: 'id', entity: 'card' } as const;
export default defineManifest('good', [
  { kind: 'route', path: '/api/cards/[id]', method: 'GET', perm: 'card.read', target: 'object', idParam: card, mutation: false },
  { kind: 'route', path: '/api/write/[id]', method: 'PATCH', perm: 'card.edit', target: 'object', idParam: card, mutation: true, touches: ['cards'] },
  { kind: 'route', path: '/api/security/[id]', method: 'POST', perm: 'authenticated', target: 'object', idParam: card, mutation: true, securityMutation: true, touches: ['cards'] },
  { kind: 'page', path: '/(op)/cards/[id]', method: 'GET', perm: 'card.read', target: 'object', idParam: card, mutation: false },
  { kind: 'action', path: '(op)/act/actions.ts#markLpr', method: 'POST', perm: 'card.edit', target: 'object', idParam: card, mutation: true, touches: ['cards'] },
]);
