// Манифест изоляции экрана «Звонить» (C7a): страница оператора. Она отдаёт только настройки (кнопки итогов,
// сроки перезвона), карточки приходят из GET /api/calls/queue (манифест calls.ts). Право — `card.outcome`:
// консультант и дежурный без него получают 404. Данных клиентов в ответе страницы нет.
import { defineManifest } from '../harness/manifest';

export default defineManifest('call', [
  { kind: 'page', path: '/(op)/call', method: 'GET', perm: 'card.outcome', target: 'section', mutation: false },
]);
