// systemActorFor (D-231): замороженный исполнитель ВНЕ реестра assertIssued (scopeSql его не примет), лишние имена отвергает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemActorFor, DOMAIN_SYSTEM_JOBS } from '../../../src/server/access/domainActor';
import { assertIssued } from '../../../src/server/access/registry';

test('systemActorFor: исполнитель заморожен и не выдан реестром — scopeSql его отвергнет', () => {
  const a = systemActorFor('booking:event_cancel', 123);
  assert.deepEqual({ ...a }, { kind: 'system', job: 'booking:event_cancel', now: 123 });
  assert.ok(Object.isFrozen(a));
  assert.throws(() => assertIssued(a), /не выдан/);
});

test('systemActorFor: литерал той же формы реестр отвергает', () => {
  assert.throws(() => assertIssued({ kind: 'system', job: 'booking:event_cancel', now: 1 }), /не выдан/);
});

test('systemActorFor: имя вне закрытого списка — ошибка', () => {
  assert.deepEqual([...DOMAIN_SYSTEM_JOBS], ['booking:event_cancel']);
  assert.throws(() => systemActorFor('purge' as never, 1), /не входит в список/);
});
