// Манифест изоляции доски оператора (U1): страница отдаёт только настройки и признаки прав, карточки приходят из
// GET /api/cards/board (манифест cards.ts). Право — `card.outcome`: консультант, дежурный и директор без него получают 404.
import { defineManifest } from '../harness/manifest';

export default defineManifest('board', [
  { kind: 'page', path: '/(op)/board', method: 'GET', perm: 'card.outcome', target: 'section', mutation: false },
]);
