// Скрытый номер клиента (`iin_hmac`, D-181, D-192): что сделать с ним в правке. Чистая функция — правило
// одно для всех правок; запись и проверка «занят ли у другого клиента» — в service.ts.
import { fields } from '@crm/core';

export type HiddenIdAction =
  /** Не трогать. */
  | { kind: 'keep' }
  /** Записать HMAC номера, принятого как ИИН. */
  | { kind: 'set'; hmac: string }
  /** Сбросить: номер очищен или форма стала «не личной». События ленты нет — как и при записи (D-181). */
  | { kind: 'clear' };

export interface HiddenIdInput {
  /** Что пришло в правке системных полей. */
  patch: Readonly<Record<string, unknown>>;
  /** HMAC из validateSystemPatch (`hiddenId`): номер принят как ИИН. */
  hiddenId: string | null;
  current: { legalForm: string; hasHiddenId: boolean };
  clientKind: 'company' | 'person';
  legalForms: readonly fields.LegalFormRef[];
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Правила (D-192): новый ИИН — `set`; очистка номера (`org_id: null` или '') — `clear`; правка формы или
 * номера, после которой номер у клиента — БИН (`orgIdNature = bin`), — `clear`: HMAC ИИН остаётся только у
 * «личной» или неопределённой формы.
 */
export function hiddenIdAction(input: HiddenIdInput): HiddenIdAction {
  if (input.hiddenId !== null) return { kind: 'set', hmac: input.hiddenId };
  if (!input.current.hasHiddenId) return { kind: 'keep' };
  const { patch } = input;
  if (Object.hasOwn(patch, 'org_id') && isEmpty(patch.org_id)) return { kind: 'clear' };
  if (!Object.hasOwn(patch, 'legal_form') && !Object.hasOwn(patch, 'org_id')) return { kind: 'keep' };
  const nextForm = Object.hasOwn(patch, 'legal_form') ? patch.legal_form : input.current.legalForm;
  return fields.orgIdNature(nextForm, input.clientKind, input.legalForms) === 'bin' ? { kind: 'clear' } : { kind: 'keep' };
}
