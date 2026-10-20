// Манифест изоляции: правка полей карточки обзвона (C8). Чужая карточка и несуществующий id отвечают одинаково (404).
import { defineManifest } from '../harness/manifest';

export default defineManifest('cards', [
  {
    kind: 'route',
    path: '/api/cards/[id]',
    method: 'PATCH',
    perm: 'card.edit',
    target: 'object',
    idParam: { name: 'id', entity: 'card' },
    sampleBody: { version: 0, set: { custom: {} }, expect: { custom: {} } },
    mutation: true,
    touches: ['cards', 'client_events'],
  },
]);
