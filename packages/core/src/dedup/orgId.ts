// БИН/идентификатор организации: ровно N цифр (по умолчанию 12), иначе пусто (PROCESS 2.3 п. 1).
// Длина — параметр, потому что это правило страны, а не ядра.

export function normalizeOrgId(raw: string | null | undefined, digits = 12): string | null {
  const d = (raw ?? '').replace(/\D+/g, '');
  return d.length === digits ? d : null;
}
