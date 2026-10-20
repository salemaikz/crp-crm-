// Манифест изоляции: платформа (healthcheck). Формат — tests/isolation/harness/manifest.ts.
import { defineManifest } from '../harness/manifest';

export default defineManifest('platform', [
  // Без данных и без БД (ARCHITECTURE §5.2): единственный маршрут вне обёртки
  { kind: 'route', path: '/api/health', method: 'GET', perm: 'public', target: 'section', mutation: false },
]);
