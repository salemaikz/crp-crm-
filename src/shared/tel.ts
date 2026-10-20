// Ссылки `tel:` и разбор номера для кнопки «Позвонить». Чистые функции: работают в браузере, на сервере и в тестах.
// Номера в базе — цифры с кодом страны (`77091234567`); в ссылку уходит международный вид `+7…`.

/** Только цифры из строки. */
export function digitsOf(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Цифры номера РК с кодом страны: `8 709 …` и `709 …` приводятся к `7709…`; иное — как есть. */
export function normalizeKzDigits(raw: string): string {
  const d = digitsOf(raw);
  if (d.length === 11 && d.startsWith('8')) return `7${d.slice(1)}`;
  if (d.length === 10) return `7${d}`;
  return d;
}

/** `tel:+77091234567`; добавочный — `;ext=`. Пустой номер — пустая строка (ссылки нет). */
export function telHref(raw: string, ext = ''): string {
  const d = normalizeKzDigits(raw);
  if (d === '') return '';
  const extDigits = digitsOf(ext);
  return extDigits ? `tel:+${d};ext=${extDigits}` : `tel:+${d}`;
}

/** Для показа: `77091234567` → `+7 709 123 45 67`; нестандартная длина — `+цифры`. */
export function formatKzPhone(raw: string): string {
  const d = normalizeKzDigits(raw);
  const m = /^7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(d);
  if (m) return `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  return d === '' ? '' : `+${d}`;
}

/** Номер с закрытой серединой для памяти устройства: `+7 709 ••• •• 67`. */
export function maskKzPhone(raw: string): string {
  const d = normalizeKzDigits(raw);
  const m = /^7(\d{3})\d{3}\d{2}(\d{2})$/.exec(d);
  if (m) return `+7 ${m[1]} ••• •• ${m[2]}`;
  return d.length > 4 ? `+${'•'.repeat(d.length - 2)}${d.slice(-2)}` : '';
}
