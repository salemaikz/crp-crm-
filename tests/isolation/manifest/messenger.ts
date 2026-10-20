// Манифест изоляции мессенджера (O7a, дизайн §8.7). Идентификаторы карточки и клиента — в теле, поэтому записи
// раздельные (как в обзвоне): оператор A шлёт карточку и клиента оператора B (cd-b-1, cl-b-1) и получает 404,
// ничего не меняя и не видя. Окно чата и «открыт WhatsApp» — чтение карточки (карточка видна — иначе 404).
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const entries: ManifestEntry[] = [
  {
    kind: 'route',
    path: '/api/messenger/chat-window',
    method: 'POST',
    perm: 'card.read',
    target: 'section',
    sampleBody: { cardId: 'cd-b-1' },
    mutation: false,
  },
  {
    kind: 'route',
    path: '/api/messenger/opened',
    method: 'POST',
    perm: 'card.read',
    target: 'section',
    sampleBody: { cardId: 'cd-b-1', templateKey: null },
    mutation: false,
  },
  {
    kind: 'route',
    path: '/api/messenger/consent',
    method: 'POST',
    perm: 'client.edit',
    target: 'section',
    sampleBody: { clientId: 'cl-b-1', action: 'given' },
    mutation: true,
    touches: ['consents'],
  },
];

export default defineManifest('messenger', entries);
