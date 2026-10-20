// Манифест изоляции: общий layout кабинета руководителя (группа (mgr)). Нужна только сессия:
// меню собирается по роли, а право на раздел проверяет каждая страница своей обёрткой page().
import { defineManifest } from '../harness/manifest';

export default defineManifest('mgr', [
  { kind: 'page', path: '/(mgr)/layout', method: 'GET', perm: 'authenticated', target: 'section', mutation: false },
]);
