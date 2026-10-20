// Закрытые списки схемы настроек (поведение в коде, CONFIG §1). Отдельный файл, чтобы integrity.ts
// и schema/v1.ts не импортировали значения друг из друга по кругу.

export const LOCALES = ['ru', 'kk'] as const;

/** Виды источника = `clients.source_kind` (CHECK в схеме БД v1). */
export const SOURCE_KINDS = ['import', 'ingest', 'manual', 'proposal', 'messenger', 'telephony', 'walk_in'] as const;

export const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'datetime', 'boolean', 'select', 'multiselect', 'phone', 'email', 'url', 'user'] as const;
/** Поля клиента и контакта — в global: клиент общий на установку (D-012, D-081). */
export const GLOBAL_FIELD_OBJECTS = ['client', 'contact'] as const;
export const SPACE_FIELD_OBJECTS = ['card', 'deal', 'booking'] as const;

export const QUEUE_BUCKETS = ['callbacks', 'retries', 'returns', 'new'] as const;

/** Виды выдачи, которые может считать лимит дня (CONFIG §6.7; подмножество `AssignKind`). */
export const CAP_KINDS = ['auto', 'manual', 'return', 'inbound', 'proposal'] as const;

/** Подстановки шаблонов напоминаний — белый список (CONFIG §6.9). */
export const REMINDER_PLACEHOLDERS = ['name', 'date', 'time', 'place'] as const;
