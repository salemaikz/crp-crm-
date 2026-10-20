// Манифест изоляции: платформа (healthcheck). Формат — tests/isolation/harness/manifest.ts.
import { defineManifest } from '../harness/manifest';

export default defineManifest('platform', [
  // Без данных и без БД (ARCHITECTURE §5.2): единственный маршрут вне обёртки
  { kind: 'route', path: '/api/health', method: 'GET', perm: 'public', target: 'section', mutation: false },
  // Корневой layout: только тема и язык из настроек, без данных клиентов
  { kind: 'page', path: '/layout', method: 'GET', perm: 'public', target: 'section', mutation: false },
]);
