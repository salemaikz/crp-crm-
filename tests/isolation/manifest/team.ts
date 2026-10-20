// Манифест изоляции модуля «Сотрудники» (R2a). Все входы — только администратор установки ('admin'):
// оператор, РОП и директор получают отказ и ничего не меняют. Объектных входов (по id клиента или карточки) нет:
// сотрудники — не охватываемая сущность, поэтому target = 'section'.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const base = { target: 'section', perm: 'admin' } as const;
const staff = '/api/team/staff';

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
];

export default defineManifest('team', entries);
