// Пароли: bcryptjs (D-006), политика нового пароля. Дизайн: docs/auth-design.md §4–5, D-093.
// Источник: платформа LMS 2cd8a2b src/lib/auth/password.ts (фиктивный хеш для несуществующего).
import bcrypt from 'bcryptjs';
import type { PasswordProblem } from './types';

export const BCRYPT_COST = 10;
export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt учитывает первые 72 байта; длиннее — отказ, а не тихое усечение. */
export const PASSWORD_MAX_BYTES = 72;
/** Тело запроса длиннее — сразу `validation`, bcrypt не считается. */
export const PASSWORD_INPUT_MAX_CHARS = 256;

/** Хеш стоимости BCRYPT_COST от случайной строки: сверка с ним занимает столько же, сколько с настоящим. */
const DUMMY_HASH = '$2b$10$2IHD0qzl/PzLqK.0LzNYQuM4cDz5OVT71kxsRMjzdcLLRyWEj8oru';

/** Частые пароли (нижний регистр): цифровые ряды, раскладки клавиатуры, словарные. Нормативный минимум, не полный словарь. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '00000000',
  '000000000',
  '0000000000',
  '0123456789',
  '11111111',
  '111111111',
  '1111111111',
  '11223344',
  '12341234',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  '123456789a',
  '123456789q',
  '12345678a',
  '12345678q',
  '1234567a',
  '1234567q',
  '12345qwert',
  '1234abcd',
  '1234qwer',
  '123qwe123',
  '123qweasd',
  '1q2w3e4r',
  '1q2w3e4r5t',
  '1qaz2wsx',
  '1qazxsw2',
  '1qazxsw23edc',
  '22222222',
  '33333333',
  '44444444',
  '55555555',
  '66666666',
  '77777777',
  '88888888',
  '987654321',
  '9876543210',
  '99999999',
  'a1234567',
  'a12345678',
  'aa123456',
  'aa12345678',
  'abc12345',
  'abcd1234',
  'abcdefgh',
  'abcdefgh1',
  'admin123',
  'admin1234',
  'administrator',
  'asdfghjk',
  'asdfghjkl',
  'baseball1',
  'changeme',
  'changeme1',
  'crm12345',
  'crm123456',
  'crmcrmcrm',
  'dragon123',
  'football1',
  'iloveyou',
  'iloveyou1',
  'letmein123',
  'master123',
  'monkey123',
  'p@ssw0rd',
  'p@ssword',
  'pa55word',
  'parol123',
  'parol1234',
  'pass1234',
  'pass12345',
  'passw0rd',
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'princess1',
  'q1w2e3r4',
  'q1w2e3r4t5',
  'qazqazqaz',
  'qazwsxedc',
  'qq123456',
  'qq1234567',
  'qwe12345',
  'qwe123456',
  'qwerty12',
  'qwerty123',
  'qwerty1234',
  'qwerty123456',
  'qwertyui',
  'qwertyuiop',
  'qwertyuiop1',
  'sunshine1',
  'superman1',
  'test1234',
  'test12345',
  'testtest',
  'trustno1',
  'user1234',
  'welcome1',
  'welcome123',
  'zaq12wsx',
  'zxcvbnm1',
  'zxcvbnm123',
  'zz123456',
  'йцукен123',
  'йцукенг123',
  'йцукенгш',
  'йцукенгшщ',
  'йцукенгшщзх',
  'пароль123',
  'пароль1234',
  'парольпароль',
  'фывапрол123',
  'фывапролд',
]);

/**
 * Проблема нового пароля или null: короче 8 символов; больше 72 байт UTF-8; из списка частых
 * (COMMON_PASSWORDS, без учёта регистра) или одна повторённая буква/цифра; совпадает с цифрами
 * номера сотрудника (полным каноном, последними 10 цифрами или с 8 вместо 7).
 */
export function passwordProblem(password: string, phoneDigits: string): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return 'too_long';
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || /^(.)\1+$/su.test(password)) return 'too_common';
  const digits = password.replace(/[\s()+-]/g, '');
  if (/^\d+$/.test(digits) && phoneDigits) {
    const tail = phoneDigits.slice(-10);
    if (digits === phoneDigits || digits === tail || digits === `8${tail}`) return 'same_as_phone';
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Сверка. Хеша нет (нет сотрудника, пароль не задан) — bcrypt по фиктивному хешу той же стоимости:
 * время ответа не выдаёт, есть ли номер. Ошибка разбора хеша — false.
 */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** Хеш создан с меньшей стоимостью, чем текущая: перехешировать при успешном входе. */
export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) < BCRYPT_COST;
  } catch {
    return false;
  }
}
