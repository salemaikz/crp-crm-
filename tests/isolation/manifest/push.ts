// Манифест изоляции web-push (P8b, D-328). Входы сотрудника личные: user_id и сессия берутся из запроса, объектных
// параметров нет; чужую подписку отписка не трогает (адрес фильтруется по user_id, проверяет tests/integration/push).
// Отписка — часть выхода на общем телефоне: мутация безопасности (D-054). Переключатель и отметка решения клиента —
// только администратор установки; выключение — мутация безопасности «выключение интеграции».
import { defineManifest, type ManifestEntry } from '../harness/manifest';

// Ключи устройства — из примера RFC 8291 §5 (синтетика), адрес — несуществующая подписка push-сервиса
const device = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-isolation-0001',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  deviceId: 'synthetic-device-0001',
};

const entries: ManifestEntry[] = [
  { kind: 'route', path: '/api/push', method: 'GET', perm: 'authenticated', target: 'section', mutation: false },
  { kind: 'route', path: '/api/push/subscribe', method: 'POST', perm: 'authenticated', target: 'section', mutation: true, touches: ['push_subscriptions', 'push_outbox'], sampleBody: device },
  {
    kind: 'route',
    path: '/api/push/unsubscribe',
    method: 'POST',
    perm: 'authenticated',
    target: 'section',
    mutation: true,
    touches: ['push_subscriptions', 'push_outbox'],
    securityMutation: true,
    sampleBody: { endpoint: device.endpoint },
  },
  { kind: 'route', path: '/api/admin/push', method: 'GET', perm: 'admin', target: 'section', mutation: false },
  {
    kind: 'route',
    path: '/api/admin/push',
    method: 'POST',
    perm: 'admin',
    target: 'section',
    mutation: true,
    touches: ['push_settings', 'audit_log'],
    sampleBody: { enabled: false, crossborderApproved: false, decisionDate: null },
  },
  { kind: 'route', path: '/api/admin/push/disable', method: 'POST', perm: 'admin', target: 'section', mutation: true, touches: ['push_settings', 'audit_log'], securityMutation: true, sampleBody: {} },
];

export default defineManifest('push', entries);
