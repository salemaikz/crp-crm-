import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reissueCookie } from '../../../src/server/platform/auth/session';

test('продлённая сессия: cookie переставляется тем же токеном с остатком срока', async () => {
  const calls: { token: string; maxAgeSec: number }[] = [];
  const ok = await reissueCookie({ expiresAt: 1_000_000 + 30 * 86_400_000 }, 'tok', 1_000_000, async (s) => {
    calls.push(s);
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ token: 'tok', maxAgeSec: 30 * 86_400 }]);
});

test('из серверного компонента cookie менять нельзя: тихо пропускаем, запрос не падает', async () => {
  const ok = await reissueCookie({ expiresAt: 5000 }, 'tok', 0, async () => {
    throw new Error('Cookies can only be modified in a Server Action or Route Handler');
  });
  assert.equal(ok, false);
});

test('Max-Age не меньше секунды', async () => {
  let got = 0;
  await reissueCookie({ expiresAt: 10 }, 't', 9, async (s) => {
    got = s.maxAgeSec;
  });
  assert.equal(got, 1);
});
