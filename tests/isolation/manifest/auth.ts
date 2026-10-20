// Манифест изоляции: вход, сессии, приглашения, личный кабинет (P3). Формат — tests/isolation/harness/manifest.ts.
// Объектов с id здесь нет (всё про себя), поэтому записи раздельные: прогон проверяет, что ответ и HTML не содержат
// данных клиентов оператора B, а недопустимая попытка (неверный пароль, чужой токен) ничего не меняет.
import { defineManifest } from '../harness/manifest';

export default defineManifest('auth', [
  { kind: 'route', path: '/api/auth/login', method: 'POST', perm: 'public', target: 'section', sampleBody: { phone: '+77099999999', password: 'неверный-пароль' }, mutation: true, touches: ['users', 'memberships', 'cards', 'clients'] },
  { kind: 'route', path: '/api/auth/invite/inspect', method: 'POST', perm: 'public', target: 'section', sampleBody: { token: 'нет-такого-токена' }, mutation: false },
  { kind: 'route', path: '/api/auth/invite/accept', method: 'POST', perm: 'public', target: 'section', sampleBody: { token: 'нет-такого-токена', password: 'Синтетика-123456' }, mutation: true, touches: ['users', 'invites', 'memberships'] },
  { kind: 'route', path: '/api/auth/logout', method: 'POST', perm: 'authenticated', target: 'section', mutation: true, securityMutation: true, touches: ['cards', 'clients'] },
  { kind: 'route', path: '/api/auth/logout-all', method: 'POST', perm: 'authenticated', target: 'section', mutation: true, securityMutation: true, touches: ['cards', 'clients'] },
  { kind: 'route', path: '/api/auth/password', method: 'POST', perm: 'authenticated', target: 'section', sampleBody: { current: 'x', next: 'y' }, mutation: true, securityMutation: true, touches: ['users'] },
  // Страницы
  { kind: 'page', path: '/', method: 'GET', perm: 'public', target: 'section', mutation: false },
  { kind: 'page', path: '/(auth)/login', method: 'GET', perm: 'public', target: 'section', mutation: false },
  { kind: 'page', path: '/(auth)/invite', method: 'GET', perm: 'public', target: 'section', mutation: false },
  { kind: 'page', path: '/(auth)/account', method: 'GET', perm: 'authenticated', target: 'section', mutation: false },
]);
