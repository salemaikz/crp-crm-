// Маска ввода номера РК `+7 (701) 555-01-23` для формы входа. Чистая функция: работает в браузере и в тестах.
// Сервер принимает любой вид (loginPhoneDigits), маска нужна только для удобства на телефоне.

/** Национальные 10 цифр из ввода: «+7…», «8…» и вставка с пробелами; «7…» — страна только если цифр больше 10. */
export function nationalDigits(raw: string): string {
  const d = raw.replace(/\D/g, '');
  let national = d;
  if (raw.trim().startsWith('+') && d.startsWith('7')) national = d.slice(1);
  else if (d.startsWith('8')) national = d.slice(1);
  else if (d.startsWith('7') && d.length > 10) national = d.slice(1);
  return national.slice(0, 10);
}

/** Отображаемое значение поля по вводу. Пустой ввод — пустая строка. */
export function formatPhoneInput(raw: string): string {
  const n = nationalDigits(raw);
  if (!n && !/\d/.test(raw)) return '';
  let out = '+7';
  if (n.length > 0) out += ` (${n.slice(0, 3)}`;
  if (n.length >= 3) out += ')';
  if (n.length > 3) out += ` ${n.slice(3, 6)}`;
  if (n.length > 6) out += `-${n.slice(6, 8)}`;
  if (n.length > 8) out += `-${n.slice(8, 10)}`;
  return out;
}
