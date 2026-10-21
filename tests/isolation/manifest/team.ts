// Манифест изоляции модуля «Сотрудники» (R2a). Все входы — только администратор установки ('admin'):
// оператор, РОП и директор получают отказ и ничего не меняют. Объектных входов (по id клиента или карточки) нет:
// сотрудники — не охватываемая сущность, поэтому target = 'section'.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const base = { target: 'section', perm: 'admin' } as const;
const staff = '/api/team/staff';
// B9a: передача клиентов открыта РОП (`client.transfer`), не администратору. Входы без id в пути — разделы.
const transfer = { target: 'section', perm: 'client.transfer' } as const;
const OP_ID = '00000000-0000-4000-8000-0000000000b9';
const TRANSFER_TOUCHES = ['cards', 'tasks', 'deals', 'bookings', 'assign_log', 'client_events', 'notifications', 'audit_log', 'change_snapshots'] as const;

const entries: ManifestEntry[] = [
  { ...base, kind: 'page', path: '/(mgr)/team', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: staff, method: 'GET', mutation: false },
  {
    ...base,
    kind: 'route',
    path: staff,
    method: 'POST',
    sampleBody: { name: 'Синтетик Приглашённый', phone: '+7 709 900 99 01', roleKey: 'operator' },
    mutation: true,
    touches: ['users', 'invites', 'memberships'],
  },
  {
    ...base,
    kind: 'route',
    path: `${staff}/[id]`,
    method: 'PATCH',
    sampleBody: { roleKey: 'consultant' },
    mutation: true,
    touches: ['users', 'memberships'],
  },
  { ...base, kind: 'route', path: `${staff}/[id]/invite`, method: 'POST', sampleBody: {}, mutation: true, touches: ['invites', 'users'] },
  { ...base, kind: 'route', path: `${staff}/[id]/invite`, method: 'DELETE', mutation: true, touches: ['invites'] },
  {
    ...base,
    kind: 'route',
    path: `${staff}/[id]/password-reset`,
    method: 'POST',
    mutation: true,
    touches: ['invites'],
    securityMutation: true,
  },
  {
    ...base,
    kind: 'route',
    path: `${staff}/[id]/disable`,
    method: 'POST',
    sampleBody: { mode: 'urgent' },
    mutation: true,
    touches: ['users', 'memberships', 'sessions', 'invites'],
    securityMutation: true,
  },
  { ...base, kind: 'route', path: `${staff}/[id]/handover-preview`, method: 'GET', mutation: false },
  { ...transfer, kind: 'page', path: '/(mgr)/team/transfer', method: 'GET', mutation: false },
  {
    ...transfer,
    kind: 'route',
    path: '/api/team/transfers/one',
    method: 'POST',
    sampleBody: { opId: OP_ID, cardId: 'cd-b-1', version: 0, toUserId: 'u-op-a' },
    mutation: true,
    touches: TRANSFER_TOUCHES,
  },
  { ...transfer, kind: 'route', path: '/api/team/transfers/preview', method: 'GET', mutation: false },
  { ...transfer, kind: 'route', path: '/api/team/transfers/staff', method: 'GET', mutation: false },
  {
    ...transfer,
    kind: 'route',
    path: '/api/team/transfers/bulk',
    method: 'POST',
    sampleBody: { opId: OP_ID, fromUserId: 'u-op-b', scope: 'working', to: { userId: 'u-op-a' } },
    mutation: true,
    touches: TRANSFER_TOUCHES,
  },
];

export default defineManifest('team', entries);
