// Заголовок автора (D-291): итог outbox — автором записи, пропуск и итог с записью — сотрудником страницы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_HEADER, createCallApi, isWrongUser } from '../../../src/ui/call/api';

test('X-Call-Author: sendOutcome — автор записи; очередь, «Сегодня», skip и postOutcome — сотрудник страницы', async () => {
  const seen: Array<[string, string | undefined]> = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push([url, (init.headers as Record<string, string>)[AUTHOR_HEADER]]);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const api = createCallApi(() => ({ 'X-Device-Id': 'd1' }), 'u-page', fake);
  await api.sendOutcome({ opId: 'x' } as never, 'u-entry');
  await api.skip({ opId: 'y', cardId: 'cd-1' });
  await api.postOutcome({ opId: 'z' } as never);
  await api.queue({ limit: 1, exclude: [], group: 'all' });
  await api.today();
  assert.deepEqual(seen, [
    ['/api/calls/outcomes', 'u-entry'],
    ['/api/calls/skips', 'u-page'],
    ['/api/calls/outcomes', 'u-page'],
    ['/api/calls/queue?limit=1&group=all', 'u-page'],
    ['/api/calls/today', 'u-page'],
  ]);
});

test('wrong_user на чтениях: очередь и «Сегодня» отдают код, страница по нему перезагружается (D-292)', async () => {
  const fake = (async () => new Response(JSON.stringify({ error: 'wrong_user', code: 'wrong_user' }), { status: 409 })) as unknown as typeof fetch;
  const api = createCallApi(() => ({}), 'u-page', fake);
  assert.equal(isWrongUser(await api.queue({ limit: 1, exclude: [], group: 'all' })), true);
  assert.equal(isWrongUser(await api.today()), true);
  assert.equal(isWrongUser({ status: 409, code: 'skip_limit' }), false);
  const offline = createCallApi(() => ({}), 'u-page', (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
  assert.deepEqual(await offline.today(), { status: 0, data: null });
});
