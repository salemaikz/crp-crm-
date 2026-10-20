// Системные поля клиента и контакта — колонки таблиц, а не `custom` (CONFIG §6.11). Пресет их не
// удаляет; права на них — разрешения, а не `fields[].access` (D-124): название, форма собственности и
// БИН — `client.edit_identity`, остальное — `client.edit`. Ключи системных полей зарезервированы:
// поле настроек с таким ключом — ошибка пресета (reservedKeyIssues).
import { normalizeBin } from '../names/companyName.js';
import { coerceValue, sameValue, type ValueContext } from './values.js';
import type { FieldChange, FieldDef, FieldIssue, FieldObject, FieldType, FieldValue } from './types.js';

export type SystemPerm = 'identity' | 'edit';

export interface SystemFieldSpec {
  /** Ключ в API и в событии ленты. */
  key: string;
  /** Колонка таблицы. */
  column: string;
  type: FieldType | 'bin' | 'legal_form';
  perm: SystemPerm;
  /** Пустым быть не может. */
  required?: boolean;
  /** Максимальная длина текста (по умолчанию — лимит типа). */
  max?: number;
}

export const CLIENT_SYSTEM_FIELDS: readonly SystemFieldSpec[] = [
  { key: 'name', column: 'name', type: 'text', perm: 'identity', required: true, max: 300 },
  { key: 'legal_form', column: 'legal_form', type: 'legal_form', perm: 'identity' },
  { key: 'org_id', column: 'org_id', type: 'bin', perm: 'identity' },
  { key: 'region', column: 'region', type: 'text', perm: 'edit', max: 200 },
  { key: 'address', column: 'address', type: 'text', perm: 'edit' },
  { key: 'email', column: 'email', type: 'email', perm: 'edit' },
  { key: 'website', column: 'website', type: 'url', perm: 'edit' },
];

export const CONTACT_SYSTEM_FIELDS: readonly SystemFieldSpec[] = [
  { key: 'name', column: 'name', type: 'text', perm: 'edit', max: 200 },
  { key: 'position', column: 'position', type: 'text', perm: 'edit', max: 200 },
  { key: 'is_decision_maker', column: 'is_decision_maker', type: 'boolean', perm: 'edit' },
  { key: 'call_hint', column: 'call_hint', type: 'text', perm: 'edit', max: 300 },
  { key: 'note', column: 'note', type: 'textarea', perm: 'edit', max: 2000 },
];

export const SYSTEM_FIELDS: Readonly<Partial<Record<FieldObject, readonly SystemFieldSpec[]>>> = {
  client: CLIENT_SYSTEM_FIELDS,
  contact: CONTACT_SYSTEM_FIELDS,
};

/** Ключи, которые нельзя занимать полями настроек объекта. */
export function reservedKeys(object: FieldObject): ReadonlySet<string> {
  return new Set((SYSTEM_FIELDS[object] ?? []).map((s) => s.key));
}

/** Поля настроек, чей ключ совпал с системным полем объекта (ошибка пресета). */
export function reservedKeyIssues(fields: readonly FieldDef[]): FieldIssue[] {
  return fields.filter((f) => reservedKeys(f.object).has(f.key)).map((f) => ({ key: f.key, code: 'unknown_field' as const }));
}

export interface LegalFormRef {
  key: string;
  /** Номер организации у этой формы — личный (ИИН): БИН в `org_id` не хранится (D-052). */
  idIsPersonal: boolean;
  archived?: boolean;
}

export interface SystemPatchInput {
  object: 'client' | 'contact';
  /** Что пришло: ключ → новое значение (null или '' — очистить). */
  patch: Readonly<Record<string, unknown>>;
  /** Текущие значения колонок по ключам системных полей. */
  current: Readonly<Record<string, FieldValue | null>>;
  /** Может ли сотрудник менять поля с perm `identity` / `edit` (охват проверяет SQL). */
  can: { identity: boolean; edit: boolean };
  /** Формы собственности `global.org.legalForms` (для клиента). */
  legalForms?: readonly LegalFormRef[];
  ctx?: ValueContext;
  /** Вид клиента: у `person` 12 цифр — всегда ИИН (D-052). */
  clientKind?: 'company' | 'person';
  /**
   * HMAC ИИН (D-052, D-141, D-181). Номер, который может быть ИИН (форма с личным номером, вид `person`,
   * форма не определена при наличии «личных» форм), в `org_id` не идёт: возвращается `hiddenId`.
   * Нет функции — такой номер отклоняется (`type`): открыто ИИН не хранится никогда.
   */
  personalIdHmac?: (digits: string) => string;
}

export interface SystemPatchResult {
  ok: boolean;
  /** Колонка → значение для UPDATE (только изменённые). Пустое значение — ''. */
  columns: Record<string, FieldValue>;
  changes: FieldChange[];
  errors: FieldIssue[];
  /**
   * HMAC номера, принятого как ИИН, — для колонки `iin_hmac`. В `columns` и `changes` (лента) его нет:
   * ни открытый ИИН, ни его HMAC в событие не попадают.
   */
  hiddenId: string | null;
}

/** Чем считать 12 цифр при данной форме и виде клиента (D-141). */
export type OrgIdNature = 'bin' | 'personal' | 'uncertain';

/**
 * `personal` — форма с личным номером или вид `person`; `bin` — известная форма без личного номера или
 * «личных» форм в настройках нет; `uncertain` — форма не определена, а «личные» формы есть: номер мог
 * быть ИИН, поэтому хранится как ИИН (считать неизвестную форму не личной D-141 отвергает).
 */
export function orgIdNature(formKey: unknown, kind: 'company' | 'person' | undefined, forms: readonly LegalFormRef[]): OrgIdNature {
  if (kind === 'person') return 'personal';
  const form = typeof formKey === 'string' && formKey ? forms.find((f) => f.key === formKey) : undefined;
  if (form) return form.idIsPersonal ? 'personal' : 'bin';
  return forms.some((f) => f.idIsPersonal) ? 'uncertain' : 'bin';
}

function asDef(spec: SystemFieldSpec, object: FieldObject): FieldDef {
  return {
    key: spec.key,
    object,
    type: spec.type === 'bin' || spec.type === 'legal_form' ? 'text' : spec.type,
    label: { ru: spec.key },
    options: [],
    access: {},
    required: { always: !!spec.required, onOutcome: [], onStage: [] },
    searchable: false,
    filterable: false,
    ingest: false,
    pii: 'none',
    showOn: { card: true, kanban: false, list: false },
  };
}

const emptyOf = (spec: SystemFieldSpec): FieldValue => (spec.type === 'boolean' ? false : '');

/**
 * Проверить правку системных полей. Неизвестный ключ — `unknown_field`; нет права — `forbidden`;
 * у формы с личным номером (`idIsPersonal`) БИН не принимается (`type`). Изменения только реальные.
 */
export function validateSystemPatch(input: SystemPatchInput): SystemPatchResult {
  const specs = SYSTEM_FIELDS[input.object] ?? [];
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const errors: FieldIssue[] = [];
  const columns: Record<string, FieldValue> = {};
  const changes: FieldChange[] = [];
  const forms = input.legalForms ?? [];

  const nextLegalForm = Object.hasOwn(input.patch, 'legal_form') ? input.patch.legal_form : input.current.legal_form;
  let hiddenId: string | null = null;

  for (const key of Object.keys(input.patch)) {
    const spec = byKey.get(key);
    if (!spec) {
      errors.push({ key, code: 'unknown_field' });
      continue;
    }
    if (!(spec.perm === 'identity' ? input.can.identity : input.can.edit)) {
      errors.push({ key, code: 'forbidden' });
      continue;
    }
    const raw = input.patch[key];
    let value: FieldValue | null;
    if (spec.type === 'bin') {
      if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) value = null;
      else {
        const bin = typeof raw === 'string' ? normalizeBin(raw) : '';
        if (!bin) {
          errors.push({ key, code: 'type' });
          continue;
        }
        const nature = orgIdNature(nextLegalForm, input.clientKind, forms);
        if (nature === 'bin' || (nature === 'uncertain' && bin === input.current.org_id)) value = bin;
        else if (!input.personalIdHmac) {
          errors.push({ key, code: 'type' });
          continue;
        } else {
          // ИИН (или «по неуверенности»): только HMAC; открытый номер прежней формы очищается
          hiddenId = input.personalIdHmac(bin);
          value = null;
        }
      }
    } else if (spec.type === 'legal_form') {
      if (raw === null || raw === undefined || raw === '') value = null;
      else if (typeof raw === 'string' && forms.some((f) => f.key === raw && (!f.archived || raw === input.current.legal_form))) value = raw;
      else {
        errors.push({ key, code: 'option' });
        continue;
      }
    } else {
      const def = asDef(spec, input.object);
      const c = coerceValue(def, raw, input.ctx);
      if (!c.ok) {
        errors.push({ key, code: c.code });
        continue;
      }
      value = c.value;
      if (typeof value === 'string' && spec.max && value.length > spec.max) {
        errors.push({ key, code: 'too_long' });
        continue;
      }
    }
    if (value === null && spec.required) {
      errors.push({ key, code: 'required' });
      continue;
    }
    const stored = value ?? emptyOf(spec);
    const before = input.current[key] ?? emptyOf(spec);
    if (sameValue(before, stored)) continue;
    columns[spec.column] = stored;
    changes.push({ key, before: before === '' ? null : before, after: stored === '' ? null : stored });
  }
  // Форма с личным номером: БИН, оставшийся от прежней формы, очищается (D-052)
  // (БИН в той же правке при такой форме уже отклонён выше).
  if (input.object === 'client' && Object.hasOwn(input.patch, 'legal_form') && !Object.hasOwn(input.patch, 'org_id') && !errors.length) {
    const personal = forms.find((f) => f.key === nextLegalForm)?.idIsPersonal ?? false;
    const bin = input.current.org_id;
    if (personal && bin) {
      columns.org_id = '';
      changes.push({ key: 'org_id', before: bin, after: null });
    }
  }
  const ok = errors.length === 0;
  return { ok, columns: ok ? columns : {}, changes: ok ? changes : [], errors, hiddenId: ok ? hiddenId : null };
}
