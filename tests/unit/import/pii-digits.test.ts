// Проверка «в журнале и отчёте нет длинных серий цифр» (номер, ИИН, БИН) не должна ловить id записей: в UUID
// importId hex-группа случайно бывает из 10+ цифр (…-2678968120d8), и тест импорта падал через раз. Вырезается
// только известный тесту id (и только если это UUID); любой другой UUID и цифры вокруг проверяются как прежде.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digitRunsExcept, withoutKnownIds } from '../../helpers/piiDigits';

const ID = '6c88acbe-5b0b-4459-b699-2678968120d8';
const META = JSON.stringify({ kind: 'csv', rows: 2200, importId: ID });

test('прежняя проверка /\\d{10,}/ ловит цифры UUID importId — ложное срабатывание', () => {
  assert.match(META, /\d{10,}/);
});

test('известный id не даёт срабатывания; длинные цифры рядом и в других полях — дают', () => {
  assert.deepEqual(digitRunsExcept(META, [ID]), []);
  assert.deepEqual(digitRunsExcept(JSON.stringify({ importId: ID, phone: '77095551234' }), [ID]), ['77095551234']);
  assert.deepEqual(digitRunsExcept(`${ID}990101300001`, [ID]), ['990101300001'], 'ИИН, приклеенный к id');
  assert.deepEqual(digitRunsExcept(`7709555${ID}1234`, [ID]), [], 'части номера по разные стороны id не склеиваются');
  assert.deepEqual(digitRunsExcept('+7 709 555 12 34', []), [], 'номер с пробелами — не серия (как и прежде)');
});

test('незнакомый UUID с длинной серией цифр по-прежнему ловится; «id» не из UUID не принимается', () => {
  assert.deepEqual(digitRunsExcept(META, []), ['2678968120']);
  assert.deepEqual(digitRunsExcept(META, ['00000000-0000-4000-8000-000000000001']), ['2678968120']);
  assert.throws(() => digitRunsExcept(META, ['77095551234']), /UUID/);
  assert.throws(() => digitRunsExcept(META, ['1234']), /UUID/);
});

// Вход (tests/integration/auth/login.test.ts): журнал session.login проверялся подстрокой «555» из номера, а в нём
// лежит случайный UUID пользователя — примерно раз на 150 прогонов UUID содержал «555», и тест падал без утечки.
const LOGIN_ROW = JSON.stringify([{ action: 'session.login', meta: {}, entityId: '0b1c5552-7d1e-4f0a-9a55-5e0c1d2f3a4b' }]);

test('прежняя проверка подстроки «555» ловит цифры UUID в журнале входа — ложное срабатывание', () => {
  assert.ok(LOGIN_ROW.includes('555'));
});

test('withoutKnownIds: известный UUID вырезается целиком, подстроки номера рядом и в других полях остаются', () => {
  const id = '0b1c5552-7d1e-4f0a-9a55-5e0c1d2f3a4b';
  assert.ok(!withoutKnownIds(LOGIN_ROW, [id]).includes('555'));
  assert.ok(withoutKnownIds(JSON.stringify({ entityId: id, phone: '77095550101' }), [id]).includes('555'));
  assert.ok(withoutKnownIds(`${id}555`, [id]).includes('555'), 'цифры, приклеенные к id');
  assert.ok(withoutKnownIds(LOGIN_ROW, ['00000000-0000-4000-8000-000000000001']).includes('555'), 'чужой UUID не вырезается');
  assert.throws(() => withoutKnownIds(LOGIN_ROW, ['77095550101']), /UUID/);
});
