// Разбор настроек обзвона: пресеты base и накладка клиента, архивные итоги, календарь, ошибки схемы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallingContext } from '../../../src/server/domain/cards/settings';
import { CallsDomainError } from '../../../src/server/domain/calls/errors';
import { assembleChain } from '../config/helpers';

const SPACE = 'sp-test';

function ctxOf(chain: Parameters<typeof assembleChain>[0], over: { archivedAt?: ReadonlyMap<string, number> } = {}) {
  const a = assembleChain(chain);
  return parseCallingContext({ spaceId: SPACE, rev: 7, global: a.global, space: a.spaces.sales, ...over });
}

test('base: справочник итогов, повторы и очередь берутся из настроек', () => {
  const c = ctxOf(['base']);
  assert.equal(c.spaceId, SPACE);
  assert.equal(c.configRev, 7);
  assert.equal(c.settings.outcomes.length, c.outcomes.length);
  assert.ok(c.settings.outcomes.length >= 7);
  assert.deepEqual(c.settings.retry.steps, ['+2h', 'nextWorkday@10:00']);
  assert.equal(c.settings.retry.maxAttempts, 3);
  assert.equal(c.settings.offlineWindowHours, 72);
  assert.equal(c.settings.callbackPastToleranceMin, 5);
  assert.deepEqual(c.queue.order, ['callbacks', 'retries', 'returns', 'new']);
  assert.equal(c.queue.skipLimit, 10);
  assert.equal(c.settings.skipLimit, c.queue.skipLimit);
  assert.equal(c.queue.mobileFirst, true);
  assert.deepEqual(c.settings.capIncludes, ['auto', 'manual', 'return']);
  assert.equal(c.overdueAlertMinutes, 60);
  assert.equal(c.settings.inboundReplyMinutes, 15);
});

test('накладка клиента: итоги, шаги и пояс без констант компании в коде', () => {
  const c = ctxOf(['base', 'kz', 'consulting-sales', 'crp']);
  const kinds = c.outcomes.map((o) => o.kind);
  for (const k of ['no_answer', 'bad_number', 'callback', 'agreed', 'not_interested', 'not_target', 'do_not_call']) assert.ok(kinds.includes(k as never), k);
  assert.equal(c.calendar.isWorkday('2026-10-28'), true, 'среда');
  assert.equal(c.calendar.isWorkday('2026-10-31'), false, 'суббота');
  assert.equal(c.settings.noShowCallbackAt.length > 0, true);
});

test('итоги отсортированы по order, requires.fields отдельно от ядра', () => {
  const c = ctxOf(['base']);
  assert.ok(c.outcomes.every((o) => Array.isArray(o.requiredFields)));
  const first = c.settings.outcomes[0]!;
  assert.equal('requiredFields' in first, false, 'ядру поля шторки не нужны');
});

test('архивный итог несёт время архивации из ревизий', () => {
  const a = assembleChain(['base']);
  const space = structuredClone(a.spaces.sales) as { calling: { outcomes: Array<{ key: string; archived?: boolean }> } };
  const key = space.calling.outcomes[0]!.key;
  space.calling.outcomes[0]!.archived = true;
  const c = parseCallingContext({ spaceId: SPACE, rev: 1, global: a.global, space, archivedAt: new Map([[key, 1_700_000_000_000]]) });
  const def = c.outcomes.find((o) => o.key === key)!;
  assert.equal(def.archived, true);
  assert.equal(def.archivedAt, 1_700_000_000_000);
  assert.equal(c.outcomes.find((o) => o.key !== key)!.archivedAt, null);
});

test('сломанный документ → invalid_settings', () => {
  const a = assembleChain(['base']);
  const bad = { ...(a.spaces.sales as Record<string, unknown>), calling: { outcomes: 'нет' } };
  const fails = (e: unknown) => e instanceof CallsDomainError && e.code === 'invalid_settings';
  assert.throws(() => parseCallingContext({ spaceId: SPACE, rev: 1, global: a.global, space: bad }), fails);
  assert.throws(() => parseCallingContext({ spaceId: SPACE, rev: 1, global: {}, space: a.spaces.sales }), fails);
});
