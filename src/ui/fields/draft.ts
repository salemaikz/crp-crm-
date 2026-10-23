// Черновик значения одного поля при вводе на месте: из значения в строку/булево/список и обратно в тело PATCH.
// Те же правила, что у формы карточки клиента: пустое — null (очистить), число уходит строкой (сервер приводит тип).
export type FieldDraft = string | boolean | string[];
export type FieldPayload = string | number | boolean | string[] | null;

export function draftOf(type: string, value: unknown): FieldDraft {
  if (type === 'boolean') return value === true;
  if (type === 'multiselect') return Array.isArray(value) ? value.map(String) : [];
  if (value === null || value === undefined || Array.isArray(value) || typeof value === 'object') return '';
  return String(value);
}

export function payloadOf(draft: FieldDraft): FieldPayload {
  if (typeof draft === 'boolean') return draft;
  if (Array.isArray(draft)) return draft.length > 0 ? draft : null;
  const s = draft.trim();
  return s === '' ? null : s;
}

/** Значение «пусто»: для «Добавить …» и для сверки `expect` (пустое и null — одно и то же). */
export function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Прежнее значение для `expect`: пустое — null, остальное как есть (число — числом: сервер сверяет строго). */
export function expectOf(value: unknown): FieldPayload {
  if (isEmptyValue(value)) return null;
  if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(String);
  return null;
}
