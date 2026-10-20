// Манифест изоляции уведомлений (P8a). Колокол личный: все входы требуют только сессию, а выдача и отметка
// «прочитано» ограничены user_id зрителя. Объектных входов (по id чужого объекта) нет: id в теле молча
// отфильтровываются по владельцу (проверяет tests/integration/notify). Страница одна на все роли: оболочку
// выбирает RoleShell, поэтому путь только в группе (op).
import { defineManifest, type ManifestEntry } from '../harness/manifest';

const base = { target: 'section', perm: 'authenticated' } as const;

const entries: ManifestEntry[] = [
  { ...base, kind: 'page', path: '/(op)/notifications', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: '/api/notify', method: 'GET', mutation: false },
  { ...base, kind: 'route', path: '/api/notify/read', method: 'POST', sampleBody: { all: true }, mutation: true, touches: ['notifications'] },
];

export default defineManifest('notify', entries);
