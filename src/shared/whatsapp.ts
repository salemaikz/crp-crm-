// Ссылка `wa.me` (простой помощник до плагина мессенджера): открывает чат с номером и готовым текстом.
import { normalizeKzDigits } from './tel';

/** `https://wa.me/77091234567?text=…`; без номера — пустая строка. Текст кодируется целиком. */
export function waHref(raw: string, text = ''): string {
  const d = normalizeKzDigits(raw);
  if (d === '') return '';
  const t = text.trim();
  return t ? `https://wa.me/${d}?text=${encodeURIComponent(t)}` : `https://wa.me/${d}`;
}
