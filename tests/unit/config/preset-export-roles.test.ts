// Право на выгрузку отчётов — только разрешение `report.export` (D-016, D-263): `export.allowedRoles` код не читает,
// а этот тест сверяет, что в собранных настройках клиента роли из `export.allowedRoles` — ровно роли с `report.export`.
// Журнал выгрузок (`export.journal`) у директора, у РОП — нет (PROCESS 8.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleChain } from './helpers';

type Role = { key: string; archived?: boolean; grants: { perm: string }[] };
type Doc = Record<string, unknown>;

test('ЦРП: роли export.allowedRoles = роли с report.export', () => {
  const a = assembleChain(['base', 'kz', 'consulting-sales', 'crp']);
  const roles = ((a.global as Doc).roles as Role[]).filter((r) => !r.archived);
  const withExport = roles.filter((r) => r.grants.some((g) => g.perm === 'report.export')).map((r) => r.key).sort();
  for (const [key, space] of Object.entries(a.spaces)) {
    const allowed = [...(((space as Doc).export as { allowedRoles: string[] }).allowedRoles)].sort();
    assert.deepEqual(allowed, withExport, `пространство ${key}`);
  }
});

test('ЦРП: журнал выгрузок — директору, РОП и операторам — нет', () => {
  const a = assembleChain(['base', 'kz', 'consulting-sales', 'crp']);
  const roles = (a.global as Doc).roles as Role[];
  const has = (key: string) => roles.find((r) => r.key === key)?.grants.some((g) => g.perm === 'export.journal') ?? false;
  assert.equal(has('director'), true);
  assert.equal(has('rop'), false);
  assert.equal(has('operator'), false);
});
