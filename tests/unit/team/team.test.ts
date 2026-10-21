// Сотрудники (R2a): входные схемы, ключи ошибок клиента, заглушка передачи дел, манифест изоляции.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InviteInput, ResendInput, UpdateInput, DisableInput } from '../../../src/server/domain/team/schemas';
import { errorKey } from '../../../src/app/(mgr)/team/api';
import manifest from '../../isolation/manifest/team';
import { walk } from '../../helpers/sourceFiles';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ru = JSON.parse(readFileSync(join(ROOT, 'messages', 'ru', 'team.json'), 'utf8')) as { errors: Record<string, string> };

test('InviteInput: телефон, имя, роль; администратор без роли; лишние поля', () => {
  const ok = { phone: '8 709 555 01 23', name: ' Анна ', roleKey: 'operator' };
  assert.equal(InviteInput.parse(ok).name, 'Анна');
  assert.throws(() => InviteInput.parse({ ...ok, phone: '123' }));
  assert.throws(() => InviteInput.parse({ ...ok, name: '   ' }));
  assert.throws(() => InviteInput.parse({ ...ok, roleKey: 'Bad Key' }));
  assert.throws(() => InviteInput.parse({ ...ok, extra: 1 }));
  assert.throws(() => InviteInput.parse({ ...ok, roleKey: null }), /role_required/);
  assert.equal(InviteInput.parse({ ...ok, roleKey: null, isAdmin: true }).roleKey, null);
});

test('UpdateInput, ResendInput, DisableInput', () => {
  assert.throws(() => UpdateInput.parse({}));
  assert.deepEqual(UpdateInput.parse({ isAdmin: false }), { isAdmin: false });
  assert.throws(() => UpdateInput.parse({ roleKey: 'rop', userId: 'x' }));
  assert.deepEqual(ResendInput.parse({}), {});
  assert.deepEqual(DisableInput.parse({}), { mode: 'urgent' });
  assert.throws(() => DisableInput.parse({ mode: 'now' }));
});

test('errorKey: detail важнее кода; все ключи есть в локали', () => {
  assert.equal(errorKey({ error: 'conflict', detail: 'exists' }, 409), 'exists');
  assert.equal(errorKey({ error: 'forbidden' }, 403), 'forbidden');
  assert.equal(errorKey({ error: 'read_only' }, 423), 'read_only');
  assert.equal(errorKey({ error: 'bad_request', detail: 'invalid' }, 400), 'invalid');
  assert.equal(errorKey(null, 500), 'generic');
  for (const k of ['exists', 'disabled', 'self_role', 'unknown_role', 'phone', 'no_space', 'not_activated', 'already_active', 'forbidden', 'unauthorized', 'not_found', 'read_only', 'invalid', 'generic', 'network']) {
    assert.ok(ru.errors[k], `нет текста ошибки ${k}`);
  }
});

test('DisableInput: получатель мастера только в режиме wizard; поровну — 2–20 разных', () => {
  assert.deepEqual(DisableInput.parse({ mode: 'wizard', to: { userId: 'u1' } }), { mode: 'wizard', to: { userId: 'u1' } });
  assert.throws(() => DisableInput.parse({ mode: 'urgent', to: { userId: 'u1' } }));
  assert.throws(() => DisableInput.parse({ mode: 'wizard', to: { even: ['u1'] } }));
  assert.throws(() => DisableInput.parse({ mode: 'wizard', to: { even: ['u1', 'u1'] } }));
  assert.ok(DisableInput.parse({ mode: 'wizard', to: { even: ['u1', 'u2'] } }));
});

test('манифест изоляции покрывает каждый маршрут и страницу модуля', () => {
  const declared = new Set(manifest.entries.map((e) => `${e.method} ${e.path}`));
  // передача клиентов (B9a) открыта РОП: остальной раздел — только администратору
  const isTransfer = (path: string) => path.startsWith('/api/team/transfers/') || path === '/(mgr)/team/transfer';
  assert.ok(manifest.entries.every((e) => (isTransfer(e.path) ? e.perm === 'client.transfer' : e.perm === 'admin')));
  const files = walk('src/app/api/team', ['.ts']).filter((f) => f.endsWith('/route.ts'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const path = '/' + f.slice('src/app/'.length).replace(/\/route\.ts$/, '');
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route\(/g)) {
      assert.ok(declared.has(`${m[1]} ${path}`), `нет в манифесте: ${m[1]} ${path}`);
    }
    assert.ok(!/export (async )?function (GET|POST|PATCH|PUT|DELETE)/.test(src), `${path}: маршрут без обёртки route()`);
  }
  assert.ok(declared.has('GET /(mgr)/team'));
  assert.match(readFileSync(join(ROOT, 'src/app/(mgr)/team/page.tsx'), 'utf8'), /page\(\{ perm: 'admin' \}/);
});
