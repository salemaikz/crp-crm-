// Манифест изоляции выгрузок (R3b): журнал выгрузок и полная выгрузка. Разделы (target = 'section'): журнал видит
// администратор и `export.journal` (сервис отвечает 403 остальным), полная выгрузка — только `data.export_all`.
// Шаг 2 полной выгрузки — мутация безопасности D-054 (журнал и уведомления): лицензия «только чтение» её не блокирует.
import { defineManifest } from '../harness/manifest';

export default defineManifest('export', [
  { kind: 'page', path: '/(mgr)/reports/exports', method: 'GET', perm: 'authenticated', target: 'section', mutation: false },
  { kind: 'route', path: '/api/export/journal', method: 'GET', perm: 'authenticated', target: 'section', mutation: false },
  {
    kind: 'route',
    path: '/api/export/full/ticket',
    method: 'POST',
    perm: 'data.export_all',
    target: 'section',
    sampleBody: { password: 'Синтетика-неверный-пароль' },
    mutation: false,
  },
  {
    kind: 'route',
    path: '/api/export/full',
    method: 'POST',
    perm: 'data.export_all',
    target: 'section',
    sampleBody: { ticket: 'zz-no-such-ticket' },
    mutation: true,
    securityMutation: true,
    touches: ['audit_log', 'notifications'],
  },
]);
