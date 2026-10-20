// Пароли: bcryptjs (D-006), политика нового пароля. Дизайн: docs/auth-design.md §5, D-093.
// Источник логики: платформа LMS 2cd8a2b src/lib/auth/password.ts (фиктивный хеш для несуществующего).
import type { PasswordProblem } from './types';

export const BCRYPT_COST = 10;
export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt учитывает первые 72 байта; длиннее — отказ, а не тихое усечение. */
export const PASSWORD_MAX_BYTES = 72;
/** Тело запроса длиннее — сразу `validation`, bcrypt не считается. */
export const PASSWORD_INPUT_MAX_CHARS = 256;

/**
 * Проблема нового пароля или null: короче 8 символов; больше 72 байт UTF-8; из списка частых
 * (COMMON_PASSWORDS, без учёта регистра) или одна повторённая буква/цифра; совпадает с цифрами
 * номера сотрудника (полным каноном или последними 10 цифрами).
 */
export function passwordProblem(password: string, phoneDigits: string): PasswordProblem | null {
  void password;
  void phoneDigits;
  throw new Error('passwordProblem: P3');
}

export function hashPassword(password: string): Promise<string> {
  void password;
  throw new Error('hashPassword: P3');
}

/**
 * Сверка. Хеша нет (нет сотрудника, пароль не задан) — bcrypt по фиктивному хешу той же стоимости:
 * время ответа не выдаёт, есть ли номер. Ошибка разбора хеша — false.
 */
export function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  void password;
  void hash;
  throw new Error('verifyPassword: P3');
}
