// Текст ошибки итога встречи. Маршрут итога отвечает кодами записи и кодами модуля сделок (требования этапа,
// D-301): код ищем сначала в `booking.errors`, затем в `deals.errors`; незнакомый — «данные изменились».

/** Минимум переводчика next-intl, нужный здесь (`useTranslations` и `createTranslator` подходят). */
export interface Translate {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/** Требования этапа, у которых подпись в локали, а не в настройках полей. */
const BUILT_IN = new Set(['booking', 'attendance']);

/**
 * `tb` — пространство `booking.errors`, `td` — `deals`. `fields` — ключи из ответа `stage_fields_required`;
 * `fieldLabels` — подписи полей сделки из настроек (ключ без подписи показывается как есть).
 */
export function meetingErrorText(
  code: string,
  fields: readonly string[] | undefined,
  tb: Translate,
  td: Translate,
  fieldLabels: Readonly<Record<string, string>>,
): string {
  if (code === 'stage_fields_required' && fields && fields.length > 0) {
    const names = fields.map((k) => (BUILT_IN.has(k) ? td(`requires.${k}`) : (fieldLabels[k] ?? k)));
    return td('errors.stage_fields_missing', { fields: names.join(', ') });
  }
  if (tb.has(code)) return tb(code);
  if (td.has(`errors.${code}`)) return td(`errors.${code}`);
  return tb('conflict');
}
