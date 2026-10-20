// Манифест изоляции модуля «вход» (ARCHITECTURE §5.3, D-017): маршруты src/app/api/auth/**.
// Объектов с чужими id здесь нет: вход, выход и смена пароля касаются только самого сотрудника.
import { defineManifest } from '../harness/manifest';

export default defineManifest('auth', [
  { kind: 'route', path: '/api/auth/login', method: 'POST', perm: 'public', target: 'section', mutation: true, touches: ['sessions', 'users'], sampleBody: { phone: '+7 709 000 11 22', password: 'x' } },
  { kind: 'route', path: '/api/auth/logout', method: 'POST', perm: 'public', target: 'section', mutation: true, touches: ['sessions'] },
  { kind: 'route', path: '/api/auth/invite/inspect', method: 'POST', perm: 'public', target: 'section', mutation: false, sampleBody: { token: 'x' } },
  { kind: 'route', path: '/api/auth/invite/accept', method: 'POST', perm: 'public', target: 'section', mutation: true, touches: ['invites', 'users', 'sessions'], sampleBody: { token: 'x', password: 'x' } },
  { kind: 'route', path: '/api/auth/logout-all', method: 'POST', perm: 'authenticated', target: 'section', mutation: true, securityMutation: true, touches: ['sessions'] },
  { kind: 'route', path: '/api/auth/password', method: 'POST', perm: 'authenticated', target: 'section', mutation: true, securityMutation: true, touches: ['sessions', 'users'], sampleBody: { current: 'x', next: 'y' } },
  { kind: 'page', path: '/(auth)/account', method: 'GET', perm: 'authenticated', target: 'section', mutation: false },
]);
