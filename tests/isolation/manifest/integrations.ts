// Манифест изоляции подключений интеграций (O7a, дизайн §7.5). Все входы — только администратор установки ('admin'):
// оператор, РОП и директор получают отказ и ничего не меняют; объектов клиентов здесь нет (target = 'section').
// Выключение и перевыпуск адреса вебхука — мутации безопасности D-054 (работают при лицензии «только чтение»).
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const base = { target: 'section', perm: 'admin' } as const;
const api = '/api/integrations';
const touches = ['integrations', 'integration_secrets', 'messenger_channels', 'audit_log'] as const;

const entries: ManifestEntry[] = [
  { ...base, kind: 'page', path: '/(mgr)/integrations', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: api, method: 'GET', mutation: false },
  { ...base, kind: 'route', path: `${api}/connect`, method: 'POST', sampleBody: { pluginId: 'messenger.wazzup', apiKey: 'synthetic-wazzup-key-0001' }, mutation: true, touches: [...touches] },
  { ...base, kind: 'route', path: `${api}/[id]/crossborder`, method: 'POST', sampleBody: { approved: true, decisionDate: '2026-10-27' }, mutation: true, touches: [...touches] },
  { ...base, kind: 'route', path: `${api}/[id]/enable`, method: 'POST', sampleBody: {}, mutation: true, touches: [...touches] },
  { ...base, kind: 'route', path: `${api}/[id]/disable`, method: 'POST', sampleBody: {}, mutation: true, touches: [...touches], securityMutation: true },
  { ...base, kind: 'route', path: `${api}/[id]/rotate-webhook`, method: 'POST', sampleBody: {}, mutation: true, touches: [...touches], securityMutation: true },
  { ...base, kind: 'route', path: `${api}/[id]/health`, method: 'POST', sampleBody: {}, mutation: true, touches: [...touches] },
  { ...base, kind: 'route', path: `${api}/[id]/channels/[channelId]`, method: 'PATCH', sampleBody: { ownerUserId: null, isEnabled: true }, mutation: true, touches: ['messenger_channels', 'audit_log'] },
];

export default defineManifest('integrations', entries);
