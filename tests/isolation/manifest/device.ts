// Манифест изоляции входов устройства (calls-design §10, D-063, D-292, D-293). Входы личные: user_id берётся из сессии,
// объектных параметров нет, чужую строку device_status пинг изменить не может (ключ — user_id + device_id).
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const entries: ManifestEntry[] = [
  { kind: 'route', path: '/api/device/ping', method: 'POST', perm: 'authenticated', target: 'section', mutation: true, touches: ['device_status'] },
  // Сверка сессии вкладки (D-292): только чтение сессии, данных не отдаёт
  { kind: 'route', path: '/api/device/session', method: 'GET', perm: 'authenticated', target: 'section', mutation: false },
  // Удаление чужих итогов с телефона по сроку (D-293, D-308): только запись журнала от имени вызвавшего, без ПДн.
  // Мутация безопасности: при лицензии «только чтение» проходит. Автор — оператор A синтетики (U.opA): прогон под B
  // доходит до записи журнала, под A — 400 (свои итоги так не удаляются).
  {
    kind: 'route',
    path: '/api/device/outbox-expired',
    method: 'POST',
    perm: 'authenticated',
    target: 'section',
    mutation: true,
    touches: ['audit_log'],
    securityMutation: true,
    sampleBody: { authorId: 'u-op-a', opIds: ['00000000-0000-4000-8000-000000000001'] },
  },
];

export default defineManifest('device', entries);
