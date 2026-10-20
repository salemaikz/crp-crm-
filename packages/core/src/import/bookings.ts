// Профиль «Записи» (PROCESS 3.7, 12.39): записи на мероприятия, сделанные до CRM. Здесь только чистая
// часть — индекс «клиент по номеру или БИН»; поиск мероприятия по дате и создание записи — домен.
// Структура реальной таблицы записей уточняется (PLAN §9 В-5), поэтому колонки сюда не зашиты.

export interface BookingEntry {
  phones: readonly string[];
  orgId?: string | null;
}

export interface BookingIndex {
  phones: ReadonlySet<string>;
  orgIds: ReadonlySet<string>;
}

export const EMPTY_BOOKING_INDEX: BookingIndex = { phones: new Set(), orgIds: new Set() };

export function createBookingIndex(entries: readonly BookingEntry[]): BookingIndex {
  const phones = new Set<string>();
  const orgIds = new Set<string>();
  for (const e of entries) {
    for (const p of e.phones) phones.add(p);
    if (e.orgId) orgIds.add(e.orgId);
  }
  return { phones, orgIds };
}

/** Есть ли у строки запись: по БИН или по любому рабочему номеру. */
export function hasBooking(row: { orgId: string | null; workingPhones: readonly string[] }, index: BookingIndex): boolean {
  return (!!row.orgId && index.orgIds.has(row.orgId)) || row.workingPhones.some((p) => index.phones.has(p));
}
