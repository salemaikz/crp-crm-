// Манифест изоляции «Настройки продаж» (R2b). Настройки — не охватываемая сущность: target = 'section'.
// Чтение — любой вошедший (сервис отвечает 403 без права и не-админу), патч — settings.sales, праздники — admin.
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const base = { target: 'section' } as const;
const sales = '/api/admin/settings/sales';
const holidays = '/api/admin/settings/holidays';

const entries: ManifestEntry[] = [
  { ...base, kind: 'page', path: '/(mgr)/settings', method: 'GET', perm: 'authenticated', mutation: false },
  { ...base, kind: 'route', path: sales, method: 'GET', perm: 'authenticated', mutation: false },
  {
    ...base,
    kind: 'route',
    path: sales,
    method: 'PATCH',
    perm: 'settings.sales',
    sampleBody: { expectedRev: { global: 1, space: 1 }, patch: { dailyCap: 41 } },
    mutation: true,
    touches: ['config_revisions', 'audit_log'],
  },
  { ...base, kind: 'route', path: holidays, method: 'GET', perm: 'authenticated', mutation: false },
  {
    ...base,
    kind: 'route',
    path: holidays,
    method: 'PUT',
    perm: 'admin',
    sampleBody: { expectedRev: { global: 1 }, holidays: [{ date: '2026-12-31', kind: 'holiday', note: 'Синтетика' }] },
    mutation: true,
    touches: ['config_revisions', 'audit_log'],
  },
];

export default defineManifest('settings', entries);
