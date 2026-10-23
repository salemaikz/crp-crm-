// Значение поля для строки карточки обзвона.
/** Вариант списка — подписью, массив — через запятую, прочее — текстом. */
export function fieldText(value: unknown, options: Record<string, string>): string {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map((v) => options[String(v)] ?? String(v)).join(', ');
  if (typeof value === 'object') return '';
  if (typeof value === 'boolean') return '';
  return options[String(value)] ?? String(value);
}
