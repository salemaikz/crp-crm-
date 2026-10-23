// Манифест изоляции: правка полей карточки обзвона (C8). Чужая карточка и несуществующий id отвечают одинаково (404).
import { defineManifest } from '../harness/manifest';

const OP_ID = '00000000-0000-4000-8000-000000000c09';

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
  // C9: действия меню карточки. Нет права (оператор на возврат и снятие «Не звонить») = нет объекта: 404.
  {
    kind: 'route',
    path: '/api/cards/[id]/reopen',
    method: 'POST',
    perm: 'card.return',
    target: 'object',
    idParam: { name: 'id', entity: 'card' },
    sampleBody: { opId: OP_ID, version: 0, comment: 'Клиент перезвонил сам' },
    mutation: true,
    touches: ['cards', 'tasks', 'notes', 'client_events', 'assign_log', 'audit_log'],
  },
  {
    kind: 'route',
    path: '/api/cards/[id]/dnc-clear',
    method: 'POST',
    perm: 'card.unblock',
    target: 'object',
    idParam: { name: 'id', entity: 'card' },
    sampleBody: { opId: OP_ID, version: 0, comment: 'Клиент снял запрет' },
    mutation: true,
    touches: ['cards', 'tasks', 'notes', 'stop_list', 'client_events', 'audit_log'],
  },
  {
    kind: 'route',
    path: '/api/cards/[id]/close',
    method: 'POST',
    perm: 'card.outcome',
    target: 'object',
    idParam: { name: 'id', entity: 'card' },
    sampleBody: { opId: OP_ID, version: 0, kind: 'not_target', reasonCode: 'other', alsoDncPhoneIds: [] },
    mutation: true,
    touches: ['cards', 'tasks', 'stop_list', 'client_events', 'bookings', 'deals'],
  },
  // C5: сервер доски. Колонки, «Ещё» и поиск — только свои карточки (scopeSql в каждом SELECT); отдел передачи и
  // консультант получают 404 (доски для них нет). Мутаций нет.
  {
    kind: 'route',
    path: '/api/cards/board',
    method: 'GET',
    perm: 'card.read',
    target: 'section',
    mutation: false,
  },
  {
    kind: 'route',
    path: '/api/cards/board/column',
    method: 'GET',
    perm: 'card.read',
    target: 'section',
    mutation: false,
  },
]);
