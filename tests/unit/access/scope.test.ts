// scopeSql без БД: форма фрагментов, FALSE/TRUE, параметры вместо текста, защита от подделки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectScope, scopeSql, scoped, ENTITY_TABLES, type ScopeFragment } from '../../../src/server/access/scope';
import { systemActor } from '../../../src/server/access/systemActor';
import { testViewer } from '../../../src/server/access/testing';
import { SCOPED_ENTITIES, type Viewer } from '../../../src/server/access/types';
import { PERMISSIONS } from '../../../packages/core/src/access';
import { presetRole, role } from './helpers';

const text = (f: ScopeFragment) => inspectScope(f).text;

const operator = () => testViewer({ userId: 'u-op-a', role: presetRole('operator'), spaceId: 'sp-1', now: Date.UTC(2026, 9, 28, 6) });

test('оператор: карточка — только своя или временная в срок замещения, в текущем пространстве; id — параметрами', () => {
  const f = inspectScope(scopeSql(operator(), 'card', 'card.read'));
  assert.equal(f.text, '((c.space_id = $1 AND (c.owner_user_id = $2 OR (c.acting_user_id = $3 AND c.acting_until_day >= $4))))');
  // сегодня — местный день установки зрителя (D-303)
  assert.deepEqual(f.values, ['sp-1', 'u-op-a', 'u-op-a', '2026-10-28']);
});

test('нет права — FALSE; система — TRUE; администратор без роли — FALSE везде', () => {
  assert.equal(text(scopeSql(operator(), 'card', 'card.assign')), 'FALSE');
  assert.equal(text(scopeSql(systemActor('test-job'), 'card', 'card.assign')), 'TRUE');
  const admin = testViewer({ userId: 'u-adm', role: null, spaceId: null, isAdmin: true });
  for (const e of SCOPED_ENTITIES) for (const p of PERMISSIONS) assert.equal(text(scopeSql(admin, e, p)), 'FALSE', `${e} ${p}`);
});

test('«только чтение»: пишущие разрешения — FALSE на всех сущностях, чтение — пространство', () => {
  const director = testViewer({ userId: 'u-dir', role: presetRole('director') });
  for (const e of SCOPED_ENTITIES) {
    for (const p of ['card.edit', 'card.outcome', 'deal.purchase', 'booking.attend', 'task.write'] as const) {
      assert.equal(text(scopeSql(director, e, p)), 'FALSE', `${e} ${p}`);
    }
  }
  assert.equal(text(scopeSql(director, 'card', 'card.read')), '((c.space_id = $1))');
});

test('поддельный Viewer той же формы отклоняется', () => {
  const real = operator();
  const fake = { ...real, grants: new Map([['card.read', 'all']]) } as unknown as Viewer;
  assert.throws(() => scopeSql(fake, 'card', 'card.read'), /не выдан/);
  assert.throws(() => scopeSql({ kind: 'system', job: 'x', now: 0 } as never, 'card', 'card.read'), /не выдан/);
});

test('Viewer заморожен: права нельзя дописать', () => {
  const v = operator();
  assert.throws(() => (v.grants as Map<string, string>).set('card.assign', 'space'));
  assert.throws(() => {
    (v as { readOnly: boolean }).readOnly = true;
  });
});

test('псевдоним — только идентификатор; служебный префикс acc_ запрещён', () => {
  assert.match(text(scopeSql(operator(), 'card', 'card.read', { alias: 'k' })), /k\.owner_user_id/);
  for (const bad of ['c; DROP TABLE cards', 'C', '1c', 'acc_c', 'c.x', '']) {
    assert.throws(() => scopeSql(operator(), 'card', 'card.read', { alias: bad }), /псевдоним/, bad);
  }
});

test('каждая сущность × каждое разрешение собирается для каждой роли (без исключений)', () => {
  for (const key of ['operator', 'rop', 'consultant', 'director', 'marketing_head', 'marketer']) {
    const v = testViewer({ userId: `u-${key}`, role: presetRole(key), teamId: 'team-1' });
    for (const e of SCOPED_ENTITIES) {
      for (const p of PERMISSIONS) {
        const f = inspectScope(scopeSql(v, e, p));
        // все значения — параметры: число $n совпадает с числом значений
        const n = (f.text.match(/\$\d+/g) ?? []).length;
        assert.equal(n, f.values.length, `${key} ${e} ${p}`);
        assert.ok(!f.text.includes(`u-${key}`), 'id сотрудника не попадает в текст запроса');
        assert.ok(f.text.includes(`${ENTITY_TABLES[e].alias}.`) || f.text === 'FALSE', `${key} ${e} ${p}: ${f.text}`);
      }
    }
  }
});

test('консультант: окно — даты записи параметрами; явка — только по своей записи, не по всем записям клиента', () => {
  const v = testViewer({ userId: 'u-cons', role: presetRole('consultant'), now: Date.UTC(2026, 9, 28, 6) });
  const read = inspectScope(scopeSql(v, 'card', 'card.read'));
  assert.ok(read.values.includes('2026-09-28') && read.values.includes('2026-10-29'));
  const attend = text(scopeSql(v, 'booking', 'booking.attend'));
  assert.match(attend, /acc_rb\.user_id/);
  assert.doesNotMatch(attend, /acc_bw/); // не «любая запись клиента в окне»
  assert.equal(text(scopeSql(v, 'card', 'card.edit')), 'FALSE');
});

test('отношение не даёт чужих действий: дежурный не открывает карточку и клиента', () => {
  const v = testViewer({ userId: 'u-op', role: presetRole('operator') });
  assert.doesNotMatch(text(scopeSql(v, 'client', 'client.read')), /event_duty/);
  assert.match(text(scopeSql(v, 'booking', 'booking.attend')), /event_duty/);
});

test('команда без teamId сужается до «своего»', () => {
  const r = role({ key: 'lead', grants: [{ perm: 'card.read', scope: 'team' }] });
  const noTeam = testViewer({ userId: 'u-l', role: r, teamId: null });
  assert.doesNotMatch(text(scopeSql(noTeam, 'card', 'card.read')), /memberships/);
  const withTeam = testViewer({ userId: 'u-l', role: r, teamId: 't-1' });
  assert.match(text(scopeSql(withTeam, 'card', 'card.read')), /memberships acc_tm/);
});

test('scoped(sql) разворачивает фрагмент в один шаблон с параметрами', async () => {
  const calls: { strings: readonly string[]; values: unknown[] }[] = [];
  const fakeSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    assert.ok(Array.isArray(strings.raw));
    calls.push({ strings: [...strings], values });
    return [];
  }) as never;
  await scoped(fakeSql)`SELECT c.id FROM cards c WHERE c.id = ${'card-9'} AND ${scopeSql(operator(), 'card', 'card.read')} LIMIT ${20}`;
  const [call] = calls;
  assert.ok(call);
  assert.deepEqual(call.values, ['card-9', 'sp-1', 'u-op-a', 'u-op-a', '2026-10-28', 20]);
  assert.equal(call.strings.length, call.values.length + 1);
  assert.equal(
    call.strings.join('?'),
    'SELECT c.id FROM cards c WHERE c.id = ? AND ((c.space_id = ? AND (c.owner_user_id = ? OR (c.acting_user_id = ? AND c.acting_until_day >= ?)))) LIMIT ?',
  );
});
