// Движок полей (K2): доступ к полю по роли, проверка записи на всех путях, проекция для ответа,
// строка поиска. Нормативно: CONFIG §6.11, ARCHITECTURE §5.2 п. 8, D-015, D-051, D-052, D-121…D-125.
// Сервер: `import { fields } from '@crm/core'` (D-101: только корень).
export type {
  CustomValues,
  FieldAccess,
  FieldChange,
  FieldDef,
  FieldIssue,
  FieldIssueCode,
  FieldLabel,
  FieldObject,
  FieldOption,
  FieldPii,
  FieldRole,
  FieldType,
  FieldValue,
  FieldViewer,
  Transition,
  WriteMode,
} from './types.js';
export { accessMap, configuredAccess, fieldsOf, filterableField, hiddenKeys, resolveAccess, visibleKeys, visibleToAllRoles } from './access.js';
export { LIMITS, coerceValue, isEmptyValue, mailtoHref, normalizeEmail, safeHttpUrl, sameValue, type Coerced, type ValueContext } from './values.js';
export { buildFieldValidator, type FieldPatchResult, type FieldValidator, type FieldValidatorInput } from './validator.js';
export {
  canSeeFieldChange,
  projectFor,
  projectValues,
  visibleFieldRefs,
  type FieldChangedData,
  type ProjectedField,
  type ProjectedOption,
  type Projection,
} from './project.js';
export {
  SEARCH_MIN_DIGITS,
  SEARCH_MIN_TEXT,
  SEARCH_NORM_MAX,
  SEARCH_QUERY_MAX,
  SEARCH_SEPARATOR,
  buildSearchNorm,
  foldForSearch,
  parseSearchQuery,
  searchableKeys,
  type SearchNormInput,
  type SearchQuery,
} from './search.js';
export {
  CLIENT_SYSTEM_FIELDS,
  CONTACT_SYSTEM_FIELDS,
  SYSTEM_FIELDS,
  reservedKeyIssues,
  reservedKeys,
  validateSystemPatch,
  type LegalFormRef,
  type SystemFieldSpec,
  type SystemPatchInput,
  type SystemPatchResult,
  type SystemPerm,
} from './system.js';
