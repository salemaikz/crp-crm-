// Свободный текст в итоге (D-293): то, что оператор ввёл сам, — заметка, имя, номер и «когда звонить» ЛПР, текстовые
// поля итога, запись внутри договорённости. Это ПДн клиента, и при выходе без сети на общем телефоне их не оставляем:
// такой итог либо уходит на сервер, либо оператор явно его удаляет. Вид полей итога знает экран «Звонить» (настройки):
// он считает признак при постановке итога в outbox. Без списка текстовых полей (старая запись) — с запасом: любое
// непустое значение поля считается текстом.
import type { OutboxEntry, OutcomeRequest } from './types';

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

export function hasFreeText(r: Pick<OutcomeRequest, 'note' | 'lprInfo' | 'fields' | 'agreement'>, textFields?: ReadonlySet<string>): boolean {
  if (filled(r.note)) return true;
  if (r.lprInfo && [r.lprInfo.name, r.lprInfo.phone, r.lprInfo.when].some(filled)) return true;
  if (Object.entries(r.fields ?? {}).some(([k, v]) => (textFields ? textFields.has(k) : true) && filled(v))) return true;
  return r.agreement?.booking != null;
}

/** Запись outbox со свободным текстом: признак из записи, а у записей без признака — проверка с запасом. */
export const entryHasFreeText = (e: Pick<OutboxEntry, 'request' | 'freeText'>): boolean => e.freeText ?? hasFreeText(e.request);
