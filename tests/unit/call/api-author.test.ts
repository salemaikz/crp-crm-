// Заголовок автора (D-291): итог outbox — автором записи, пропуск и итог с записью — сотрудником страницы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_HEADER, createCallApi } from '../../../src/ui/call/api';

test('X-Call-Author: sendOutcome — автор записи; skip и postOutcome — сотрудник страницы', async () => {
  const seen: Array<[string, string | undefined]> = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push([url, (init.headers as Record<string, string>)[AUTHOR_HEADER]]);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const api = createCallApi(() => ({ 'X-Device-Id': 'd1' }), 'u-page', fake);
  await api.sendOutcome({ opId: 'x' } as never, 'u-entry');
  await api.skip({ opId: 'y', cardId: 'cd-1' });
  await api.postOutcome({ opId: 'z' } as never);
  assert.deepEqual(seen, [
    ['/api/calls/outcomes', 'u-entry'],
    ['/api/calls/skips', 'u-page'],
    ['/api/calls/outcomes', 'u-page'],
  ]);
});
