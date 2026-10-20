// Матрица прав ролей пресета первого клиента (PROCESS §8.2, CONFIG §6.10): каждая роль × каждое
// разрешение каталога. Ожидание записано явно: любое расширение прав роли роняет тест и требует
// ревью architect (PLAN §2: grants ролей — только architect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, effectiveAccess, isWritePermission, roleGrants, roleRelations, type Permission } from '../../../packages/core/src/access';
import { checkGuard, isMutation } from '../../../src/server/access/wrappers';
import { testViewer } from '../../../src/server/access/testing';
import { presetRoles } from './helpers';

const ROLES = ['operator', 'rop', 'consultant', 'director', 'marketing_head', 'marketer'] as const;
type RoleKey = (typeof ROLES)[number];

// Ячейка: охват роли ('own' | 'team' | 'space' | 'all'), '+rel' — ещё и через отношение, 'rel' — только
// через отношение, '-' — нет. Столбцы — в порядке ROLES.
const S = 'space';
const MATRIX: Record<Permission, readonly [string, string, string, string, string, string]> = {
  //                     оператор   РОП  консульт.  директор  рук. отдела  маркетолог
  'card.read':            ['own',    S,   'rel',     S,        'rel',       'rel'],
  'card.outcome':         ['own',    S,   '-',       '-',      '-',         '-'],
  'card.edit':            ['own',    S,   '-',       '-',      '-',         '-'],
  'card.assign':          ['-',      S,   '-',       '-',      '-',         '-'],
  'card.return':          ['-',      S,   '-',       '-',      '-',         '-'],
  'card.unblock':         ['-',      S,   '-',       '-',      '-',         '-'],
  'card.export':          ['-',      S,   '-',       '-',      '-',         '-'],
  'client.read':          ['own',    S,   'rel',     S,        'rel',       'rel'],
  'client.edit':          ['own',    S,   '-',       '-',      '-',         '-'],
  'client.edit_identity': ['-',      S,   '-',       '-',      '-',         '-'],
  'client.merge':         ['-',      S,   '-',       '-',      '-',         '-'],
  'client.transfer':      ['-',      S,   '-',       '-',      '-',         '-'],
  'client.propose':       ['own',    S,   '-',       '-',      '-',         '-'],
  'deal.read':            ['own',    S,   'rel',     S,        'rel',       'rel'],
  'deal.edit':            ['-',      S,   'rel',     '-',      '-',         '-'],
  'deal.purchase':        ['-',      S,   'rel',     '-',      '-',         '-'],
  'deal.move_back':       ['-',      S,   '-',       '-',      '-',         '-'],
  'booking.read':         ['own+rel', S,  'rel',     S,        '-',         '-'],
  'booking.create':       ['own',    S,   'rel',     '-',      '-',         '-'],
  'booking.attend':       ['rel',    S,   'rel',     '-',      '-',         '-'],
  'booking.manage':       ['-',      S,   '-',       '-',      '-',         '-'],
  'booking.walk_in':      ['rel',    S,   'rel',     '-',      '-',         '-'],
  'note.write':           ['own',    S,   'rel',     '-',      '-',         '-'],
  'task.read':            ['own',    S,   'own',     S,        'own+rel',   'own+rel'],
  'task.write':           ['own',    S,   'own',     '-',      'own+rel',   'own+rel'],
  'task.assign_others':   ['-',      S,   '-',       '-',      '-',         '-'],
  'handoff.read':         ['-',      S,   '-',       S,        'rel',       'rel'],
  'handoff.accept':       ['-',      '-', '-',       '-',      'rel',       '-'],
  'handoff.assign':       ['-',      '-', '-',       '-',      'rel',       '-'],
  'pool.read':            ['-',      S,   '-',       '-',      '-',         '-'],
  'distribution.manage':  ['-',      S,   '-',       '-',      '-',         '-'],
  'import.run':           ['-',      S,   '-',       '-',      '-',         '-'],
  'report.view':          ['own',    S,   'own',     S,        'team',      '-'],
  'report.export':        ['-',      S,   '-',       S,        '-',         '-'],
  'data.export_all':      ['-',      S,   '-',       S,        '-',         '-'],
  'settings.sales':       ['-',      S,   '-',       '-',      '-',         '-'],
  'settings.fields':      ['-',      '-', '-',       '-',      '-',         '-'],
};

function cell(key: RoleKey, perm: Permission): string {
  const r = presetRoles().find((x) => x.key === key)!;
  const a = effectiveAccess(roleGrants(r), roleRelations(r), perm);
  if (a.scope && a.relations.length) return `${a.scope}+rel`;
  if (a.scope) return a.scope;
  return a.relations.length ? 'rel' : '-';
}

test('в пресете ровно эти роли; администратор — признак учётки, дежурство — отношение', () => {
  assert.deepEqual(presetRoles().map((r) => r.key).sort(), [...ROLES].sort());
});

test('матрица покрывает весь каталог разрешений', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...PERMISSIONS].sort());
});

for (const [ri, key] of ROLES.entries()) {
  test(`матрица прав: ${key}`, () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const p of PERMISSIONS) {
      got[p] = cell(key, p);
      want[p] = MATRIX[p][ri] as string;
    }
    assert.deepEqual(got, want);
  });
}

test('директор только читает: любая мутация → 423 до проверки права, выгрузки — разрешены', () => {
  const director = testViewer({ userId: 'u-dir', role: presetRoles().find((r) => r.key === 'director')! });
  for (const p of PERMISSIONS) {
    const mutation = isMutation(p, true);
    let outcome = 'ok';
    try {
      checkGuard(director, { perm: p, target: 'object' }, mutation);
    } catch (e) {
      outcome = (e as { code: string }).code;
    }
    if (isWritePermission(p)) assert.equal(outcome, 'read_only', p);
    else assert.equal(outcome, MATRIX[p][3] === '-' ? 'not_found' : 'ok', p);
  }
});

test('каждая роль × каждое разрешение: обёртка пускает ровно по матрице (объект → 404, раздел → 403)', () => {
  for (const [ri, key] of ROLES.entries()) {
    const v = testViewer({ userId: `u-${key}`, role: presetRoles().find((r) => r.key === key)! });
    for (const p of PERMISSIONS) {
      if (v.readOnly && isWritePermission(p)) continue; // проверено выше: 423
      const allowed = MATRIX[p][ri] !== '-';
      for (const target of ['object', 'section'] as const) {
        let code = 'ok';
        try {
          checkGuard(v, { perm: p, target }, false);
        } catch (e) {
          code = (e as { code: string }).code;
        }
        assert.equal(code, allowed ? 'ok' : target === 'object' ? 'not_found' : 'forbidden', `${key} ${p} ${target}`);
      }
    }
  }
});

test('администратор без роли: ни одного разрешения на данные клиентов', () => {
  const admin = testViewer({ userId: 'u-admin', role: null, spaceId: null, isAdmin: true });
  for (const p of PERMISSIONS) assert.throws(() => checkGuard(admin, { perm: p, target: 'object' }, false), { code: 'not_found' }, p);
  assert.doesNotThrow(() => checkGuard(admin, { perm: 'admin' }, true));
});
