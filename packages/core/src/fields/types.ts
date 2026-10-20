// Типы движка полей (CONFIG §6.11, D-015, D-051, D-121…D-125). Определение поля — то же, что в
// `global.fields[]` и `fields[]` пространства; здесь — структурный тип без zod, чтобы движок не
// зависел от версии схемы настроек (совместимость проверяет fields.test.ts).
import type { FIELD_TYPES } from '../config/schema/constants.js';

export type FieldType = (typeof FIELD_TYPES)[number];
export type FieldObject = 'client' | 'contact' | 'card' | 'deal' | 'booking';
export type FieldAccess = 'edit' | 'read' | 'hidden';
export type FieldPii = 'none' | 'person' | 'contact';

export interface FieldLabel {
  ru: string;
  kk?: string;
}

export interface FieldOption {
  key: string;
  label: FieldLabel;
  archived?: boolean;
}

/** Определение поля из настроек (CONFIG §6.11). */
export interface FieldDef {
  key: string;
  object: FieldObject;
  type: FieldType;
  label: FieldLabel;
  options: readonly FieldOption[];
  /** Ключ — роль или `*`. */
  access: Readonly<Record<string, FieldAccess>>;
  required: { always: boolean; onOutcome: readonly string[]; onStage: readonly string[] };
  searchable: boolean;
  filterable: boolean;
  ingest: boolean;
  pii: FieldPii;
  showOn: { card: boolean; kanban: boolean; list: boolean };
  archived?: boolean;
}

/** Значение поля в `custom jsonb`: строка, число, булево или список ключей вариантов. */
export type FieldValue = string | number | boolean | string[];
export type CustomValues = Readonly<Record<string, FieldValue>>;

/**
 * Кто смотрит или пишет. Собирает сервер из Viewer и роли настроек:
 * - `roleKey` — роль в текущем пространстве; null — нет роли (ничего не видно);
 * - `fieldAccessDefault` — из роли (`global.roles[].fieldAccessDefault`);
 * - `canEdit` — есть пишущее разрешение объекта (`client.edit` и т. п.) и роль не «только чтение».
 *   Без него `edit` из настроек понижается до `read`.
 */
export interface FieldViewer {
  roleKey: string | null;
  fieldAccessDefault: FieldAccess;
  canEdit: boolean;
}

/** Роль для расчёта «поле видно всем» (поиск, D-123). */
export interface FieldRole {
  key: string;
  fieldAccessDefault: FieldAccess;
  archived?: boolean;
}

/** Путь записи: от него зависит строгость (D-122). */
export type WriteMode =
  /** Сотрудник из интерфейса или API: ошибки блокируют запись целиком (400). */
  | 'user'
  /** Приём и импорт: плохие и лишние значения отбрасываются с предупреждением, запись идёт. */
  | 'ingest'
  /** Система, CLI, слияние: без проверки ролей, ошибки блокируют. */
  | 'system';

/** Что происходит с объектом: от этого зависит обязательность полей. */
export type Transition =
  | { kind: 'edit' }
  | { kind: 'outcome'; outcome: string }
  | { kind: 'stage'; stage: string };

export type FieldIssueCode =
  | 'unknown_field' // нет такого поля у объекта или оно скрыто для роли (одинаково, D-122)
  | 'forbidden' // поле видно, но только для чтения
  | 'archived' // поле в архиве: новые значения не принимаются
  | 'not_ingest' // приём: поле не помечено `ingest`
  | 'person_dropped' // приём: `pii: person` у источника без allowPersonNames (D-052)
  | 'type'
  | 'too_long'
  | 'option'
  | 'url'
  | 'email'
  | 'phone'
  | 'range'
  | 'date'
  | 'user'
  | 'required';

export interface FieldIssue {
  key: string;
  code: FieldIssueCode;
}

export interface FieldChange {
  key: string;
  before: FieldValue | null;
  after: FieldValue | null;
}
