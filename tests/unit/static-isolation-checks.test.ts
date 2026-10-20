// Самопроверка чистых проверок прогона изоляции (tests/isolation/runner/checks.ts): на заведомо плохих
// ответах они дают нарушения, на хороших — нет. Прогон на БД — tests/isolation/run.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashViolations, leakViolations, nameNeedle, normalizeBody, notFoundViolations, phoneNeedle, snapshotViolations, type Reply } from '../isolation/runner/checks';
import { cookies, headers, withRequestScope } from '../isolation/runner/shims/nextHeaders';

const reply = (status: number, body = '', headers: Record<string, string> = {}): Reply => ({ status, body, headers });
const NOT_FOUND = { 'content-type': 'application/json', 'cache-control': 'no-store' };

test('номер находят в любом написании, название — с HTML-экранированием и без учёта регистра', () => {
  const needles = [phoneNeedle('77091000001'), nameNeedle('ТОО «Альфа & Бета»'), '990100300001'];
  for (const text of ['+7 709 100 00 01', '8 (709) 100-00-01', '7091000001', '<td>+7&nbsp;709</td>']) {
    assert.equal(leakViolations('t', reply(200, text), needles).length, text.includes('nbsp') ? 0 : 1, text);
  }
  assert.equal(leakViolations('t', reply(200, '<h1>тоо «альфа &amp; бета»</h1>'), needles).length, 1);
  assert.equal(leakViolations('t', reply(200, 'БИН 990100300001'), needles).length, 1);
  assert.equal(leakViolations('t', reply(200, '{"error":"not_found"}'), needles).length, 0);
  // утечка в заголовке и в Location тоже утечка
  assert.equal(leakViolations('t', { ...reply(302), location: '/clients/ТОО «Альфа & Бета»' }, needles).length, 1);
  // значение утечки в сообщение не попадает
  assert.doesNotMatch(leakViolations('t', reply(200, '990100300001'), needles).join(''), /9901003/);
});

test('404 чужого и несуществующего должны совпасть; различие в статусе, теле или заголовках ловится', () => {
  const ok = notFoundViolations({ foreign: reply(404, '{"error":"not_found","id":"cd-b-1"}', NOT_FOUND), missing: reply(404, '{"error":"not_found","id":"zz"}', NOT_FOUND), foreignId: 'cd-b-1', missingId: 'zz' });
  assert.deepEqual(ok, []);
  assert.match(notFoundViolations({ foreign: reply(403, '', NOT_FOUND), missing: reply(404, '', NOT_FOUND), foreignId: 'a', missingId: 'b' }).join(), /ждали 404, получили 403/);
  assert.match(notFoundViolations({ foreign: reply(404, 'нет доступа', NOT_FOUND), missing: reply(404, 'нет такого', NOT_FOUND), foreignId: 'a', missingId: 'b' }).join(), /отличается телом/);
  assert.match(notFoundViolations({ foreign: reply(404, '', { ...NOT_FOUND, 'cache-control': 'public' }), missing: reply(404, '', NOT_FOUND), foreignId: 'a', missingId: 'b' }).join(), /cache-control/);
  assert.match(notFoundViolations({ foreign: reply(200, '{"name":"x"}'), missing: reply(404), foreignId: 'a', missingId: 'b' }).join(), /ждали 404, получили 200/);
  assert.equal(normalizeBody('/cards/a%20b and a b', ['a b']), '/cards/<id> and <id>');
});

test('снимок таблиц: изменение строки, добавление и удаление ловятся', () => {
  assert.deepEqual(snapshotViolations('x', { cards: 'a', notes: 'b' }, { cards: 'a', notes: 'b' }), []);
  assert.equal(snapshotViolations('x', { cards: 'a' }, { cards: 'a2' }).length, 1);
  assert.equal(snapshotViolations('x', { cards: 'a' }, { cards: 'a', notes: 'n' }).length, 1);
});

test('5xx — всегда нарушение', () => {
  assert.equal(crashViolations('x', reply(500, 'boom')).length, 1);
  assert.equal(crashViolations('x', reply(404)).length, 0);
});

test('подмена next/headers: cookie и заголовки живут только внутри области запроса', async () => {
  const outside = await cookies();
  assert.equal(outside.get('a'), undefined);
  await withRequestScope({ headers: { host: 'crm.test' }, cookies: { sid: 't1' } }, async () => {
    const jar = await cookies();
    assert.equal(jar.get('sid')?.value, 't1');
    jar.set('sid', '');
    assert.equal((await cookies()).has('sid'), false);
    assert.equal((await headers()).get('host'), 'crm.test');
  });
  assert.equal((await cookies()).has('sid'), false);
});
