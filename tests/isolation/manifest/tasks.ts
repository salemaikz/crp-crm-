// Манифест изоляции экрана задач (B7): список, ручная задача, правка, «Готово», отмена, комментарии, исполнители,
// страница /tasks. Чужая задача (tk-b-1 оператора B) и несуществующий id отвечают одинаково (404), таблицы задач,
// комментариев, ленты и уведомлений у чужих не меняются. Синтетика: «ТОО Синтетика …», номера +7 709 ….
import { defineManifest } from '../harness/manifest';

const OP_ID = '00000000-0000-4000-8000-0000000007b7';
const TASK_TABLES = ['tasks', 'task_comments', 'client_events', 'notifications'] as const;

export default defineManifest('tasks', [
  { kind: 'route', path: '/api/tasks', method: 'GET', perm: 'task.read', target: 'section', mutation: false },
  {
    kind: 'route',
    path: '/api/tasks',
    method: 'POST',
    perm: 'task.write',
    target: 'section',
    // Задача на клиента оператора B: у A — 404, ничего не записано
    sampleBody: { opId: OP_ID, clientId: 'cl-b-1', kind: 'call', title: 'Пример', dueAt: null, assigneeUserId: 'u-op-a' },
    mutation: true,
    touches: TASK_TABLES,
  },
  { kind: 'route', path: '/api/tasks/assignees', method: 'GET', perm: 'task.write', target: 'section', mutation: false },
  {
    kind: 'route',
    path: '/api/tasks/[id]',
    method: 'GET',
    perm: 'task.read',
    target: 'object',
    idParam: { name: 'id', entity: 'task' },
    mutation: false,
  },
  {
    kind: 'route',
    path: '/api/tasks/[id]',
    method: 'PATCH',
    perm: 'task.write',
    target: 'object',
    idParam: { name: 'id', entity: 'task' },
    sampleBody: { dueAt: null },
    mutation: true,
    touches: TASK_TABLES,
  },
  {
    kind: 'route',
    path: '/api/tasks/[id]/done',
    method: 'POST',
    perm: 'task.write',
    target: 'object',
    idParam: { name: 'id', entity: 'task' },
    sampleBody: {},
    mutation: true,
    touches: TASK_TABLES,
  },
  {
    kind: 'route',
    path: '/api/tasks/[id]/cancel',
    method: 'POST',
    perm: 'task.write',
    target: 'object',
    idParam: { name: 'id', entity: 'task' },
    mutation: true,
    touches: TASK_TABLES,
  },
  {
    kind: 'route',
    path: '/api/tasks/[id]/comments',
    method: 'POST',
    perm: 'task.write',
    target: 'object',
    idParam: { name: 'id', entity: 'task' },
    sampleBody: { opId: OP_ID, body: 'Комментарий пример' },
    mutation: true,
    touches: TASK_TABLES,
  },
  { kind: 'page', path: '/(op)/tasks', method: 'GET', perm: 'task.read', target: 'section', mutation: false },
]);
