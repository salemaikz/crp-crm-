// Манифест изоляции досок (B8): сделки по этапам и вид «Обзвон» РОП. Это разделы (target = 'section'): охват проверяет
// сервис досок (SQL с scopeSql), оператор получает 403 (обзвон) или свои сделки (доска сделок), гость — 401.
// Только чтение: перенос идёт маршрутами сделок (B6) и итогов (/api/calls/outcomes, манифест calls).
import { defineManifest } from '../harness/manifest';

export default defineManifest('kanban', [
  { kind: 'page', path: '/(mgr)/deals', method: 'GET', perm: 'deal.read', target: 'section', mutation: false },
  { kind: 'page', path: '/(mgr)/deals/calling', method: 'GET', perm: 'card.read', target: 'section', mutation: false },
  { kind: 'route', path: '/api/kanban/deals', method: 'GET', perm: 'deal.read', target: 'section', mutation: false },
  { kind: 'route', path: '/api/kanban/deals/column', method: 'GET', perm: 'deal.read', target: 'section', mutation: false },
  { kind: 'route', path: '/api/kanban/deals/closed', method: 'GET', perm: 'deal.read', target: 'section', mutation: false },
  { kind: 'route', path: '/api/kanban/calling', method: 'GET', perm: 'card.read', target: 'section', mutation: false },
  { kind: 'route', path: '/api/kanban/calling/column', method: 'GET', perm: 'card.read', target: 'section', mutation: false },
]);
