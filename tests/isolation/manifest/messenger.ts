// Манифест изоляции мессенджера (O7a, дизайн §8.7, D-297). Окно чата — объектная запись: id карточки в пути,
// оператор A с карточкой оператора B (cd-b-1) получает 404, как на несуществующую. «Открыт WhatsApp» и согласие —
// id в теле, записи раздельные (как в обзвоне): A шлёт карточку и клиента B и получает 404, ничего не меняя.
// Окно чата и «открыт WhatsApp» — пишущие действия (`note.write`): при лицензии «только чтение» — 423.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const entries: ManifestEntry[] = [
  {
    kind: 'route',
    path: '/api/messenger/chat-window/[cardId]',
    method: 'POST',
    perm: 'note.write',
    target: 'object',
    idParam: { name: 'cardId', entity: 'card' },
    mutation: true,
    touches: ['audit_log', 'client_events'],
  },
  {
    kind: 'route',
    path: '/api/messenger/opened',
    method: 'POST',
    perm: 'note.write',
    target: 'section',
    sampleBody: { cardId: 'cd-b-1', templateKey: null },
    mutation: true,
    touches: ['client_events'],
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
