// Схема раздела ролей и валидатор опасных сочетаний (ARCHITECTURE §5.1 п. 5, CONFIG §3.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, RELATIONS, RolesSchema, SCOPES, validateRoles, type RoleConfig } from '../../../packages/core/src/access';
import { role } from './helpers';

const codes = (roles: RoleConfig[]) => validateRoles(roles).map((i) => i.code);

test('корректная роль проходит схему', () => {
  const r = RolesSchema.safeParse([role({ grants: [{ perm: 'card.read', scope: 'own' }] })]);
  assert.equal(r.success, true);
});

test('схема строгая: неизвестное разрешение, охват, поле и ключ отклоняются', () => {
  const bad: unknown[] = [
    [{ ...role(), grants: [{ perm: 'card.delete', scope: 'own' }] }],
    [{ ...role(), grants: [{ perm: 'card.read', scope: 'company' }] }],
    [{ ...role(), extra: true }],
    [{ ...role(), key: 'Operator' }],
    [{ ...role(), key: 'x' }],
    [{ ...role(), label: { ru: '' } }],
    [{ ...role(), relations: [{ key: 'booked_with_me', params: { fromDays: -1 }, actions: [] }] }],
    [{ ...role(), relations: [{ key: 'knows_me', params: {}, actions: [] }] }],
    [{ ...role(), relations: [{ key: 'duty_today', params: { days: 1 }, actions: [] }] }],
    [],
  ];
  for (const b of bad) assert.equal(RolesSchema.safeParse(b).success, false, JSON.stringify(b));
});

test('у схемы нет значений по умолчанию (D-061): обязательные поля обязательны', () => {
  const { readOnly: _r, ...noReadOnly } = role();
  void _r;
  assert.equal(RolesSchema.safeParse([noReadOnly]).success, false);
  const { menu: _m, ...noMenu } = role();
  void _m;
  assert.equal(RolesSchema.safeParse([noMenu]).success, false);
});

test('валидатор: «своё» на чтение карточек несовместимо с раздачей, пулом, назначением и передачей', () => {
  for (const p of ['distribution.manage', 'pool.read', 'card.assign', 'client.transfer'] as const) {
    const r = role({ grants: [{ perm: 'card.read', scope: 'own' }, { perm: p, scope: 'space' }] });
    assert.ok(codes([r]).includes('own_with_pool_powers'), p);
    assert.equal(RolesSchema.safeParse([r]).success, false);
  }
  const ok = role({ grants: [{ perm: 'card.read', scope: 'space' }, { perm: 'pool.read', scope: 'space' }] });
  assert.deepEqual(codes([ok]), []);
});

test('валидатор: разрешения пространства не выдаются на «своё» и «команду»', () => {
  for (const scope of ['own', 'team'] as const) {
    assert.ok(codes([role({ grants: [{ perm: 'data.export_all', scope }] })]).includes('scope_too_narrow'));
    assert.ok(codes([role({ grants: [{ perm: 'import.run', scope }] })]).includes('scope_too_narrow'));
  }
  assert.deepEqual(codes([role({ grants: [{ perm: 'data.export_all', scope: 'all' }] })]), []);
});

test('валидатор: «только чтение» — без пишущих прав и действий отношений, выгрузки отчётов и полная разрешены', () => {
  const ro = (over: Partial<RoleConfig>) => role({ readOnly: true, ...over });
  assert.ok(codes([ro({ grants: [{ perm: 'card.edit', scope: 'space' }] })]).includes('read_only_write'));
  assert.ok(codes([ro({ grants: [{ perm: 'card.export', scope: 'space' }] })]).includes('read_only_write'));
  assert.ok(
    codes([ro({ relations: [{ key: 'duty_today', params: {}, actions: ['booking.attend'] }] })]).includes('read_only_write'),
  );
  assert.deepEqual(
    codes([
      ro({
        grants: [
          { perm: 'card.read', scope: 'space' },
          { perm: 'report.export', scope: 'space' },
          { perm: 'data.export_all', scope: 'space' },
        ],
        relations: [{ key: 'duty_today', params: {}, actions: [] }],
      }),
    ]),
    [],
  );
});

test('валидатор: действия отношения — только из списка кода (пресет может только сузить)', () => {
  for (const key of Object.keys(RELATIONS) as (keyof typeof RELATIONS)[]) {
    const allowed = RELATIONS[key].actions;
    const params = key === 'booked_with_me' ? { fromDays: -1, toDays: 30 } : {};
    const extra = PERMISSIONS.find((p) => !allowed.includes(p))!;
    const mk = (actions: RoleConfig['relations'][number]['actions']) =>
      role({ relations: [{ key, params, actions } as RoleConfig['relations'][number]] });
    assert.deepEqual(codes([mk([...allowed])]), [], key);
    assert.deepEqual(codes([mk([])]), [], key);
    assert.ok(codes([mk([extra])]).includes('relation_action_not_allowed'), `${key} + ${extra}`);
  }
});

test('валидатор: дубли ролей, разрешений, отношений и действий', () => {
  assert.ok(codes([role(), role()]).includes('duplicate_role'));
  assert.ok(codes([role({ grants: [{ perm: 'card.read', scope: 'own' }, { perm: 'card.read', scope: 'space' }] })]).includes('duplicate_grant'));
  const d = { key: 'duty_today' as const, params: {}, actions: [] };
  assert.ok(codes([role({ relations: [d, d] })]).includes('duplicate_relation'));
  assert.ok(
    codes([role({ relations: [{ key: 'duty_today', params: {}, actions: ['booking.attend', 'booking.attend'] }] })]).includes('duplicate_action'),
  );
});

test('каталог: охваты и разрешения — закрытые списки без повторов', () => {
  assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length);
  assert.deepEqual([...SCOPES], ['own', 'team', 'space', 'all']);
  for (const p of PERMISSIONS) assert.match(p, /^[a-z_]+\.[a-z_]+$/);
});
