// Манифест изоляции пинга устройства (calls-design §10, D-063). Вход один, личный: user_id берётся из сессии,
// объектных параметров нет, чужую строку device_status пинг изменить не может (ключ — user_id + device_id).
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const entries: ManifestEntry[] = [
  { kind: 'route', path: '/api/device/ping', method: 'POST', perm: 'authenticated', target: 'section', mutation: true, touches: ['device_status'] },
];

export default defineManifest('device', entries);
