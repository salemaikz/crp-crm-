// Оболочка: счётчик колокольчика берётся из unreadCount(viewer) (P8a), кнопка «Выйти» стоит в «Ещё» и на боковой панели.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(import.meta.dirname, '..', '..', rel), 'utf8');

test('RoleShell: бейдж колокольчика из unreadCount, явный bellCount важнее', () => {
  const text = read('src/ui/shells/RoleShell.tsx');
  assert.match(text, /import \{ unreadCount \} from '@\/server\/domain\/notify'/);
  assert.match(text, /bellCount === undefined \? unreadCount\(viewer\)/);
  assert.match(text, /count: unread/);
});

test('оболочка: «Выйти» есть в «Ещё» телефона и в боковой колонке, получает сотрудника', () => {
  const app = read('src/ui/shells/AppShell.tsx');
  assert.match(app, /logout: <LogoutButton userId=\{userId\} \/>/);
  assert.match(app, /<LogoutButton userId=\{userId\} \/>/);
  assert.match(read('src/ui/shells/ShellNav.tsx'), /<li>\{more\.logout\}<\/li>/);
  assert.match(read('src/ui/shells/RoleShell.tsx'), /userId=\{viewer\.userId\}/);
});

test('выход: сначала отправка итогов и предупреждение, потом очистка кэша оболочки и POST /api/auth/logout', () => {
  const button = read('src/ui/shells/LogoutButton.tsx');
  assert.ok(button.indexOf('await flushDeviceOutbox(') < button.indexOf('await finishLogout(userId)'), 'итоги отправляются до выхода');
  const logout = read('src/ui/call/logout.ts');
  assert.ok(logout.indexOf('clearShellCache()') < logout.indexOf("'/api/auth/logout'"), 'кэш очищается до закрытия сессии');
});
