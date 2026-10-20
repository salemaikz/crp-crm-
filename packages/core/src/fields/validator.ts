// buildFieldValidator — одна проверка значений `custom` на всех путях записи (D-015, D-122):
// карточка, шторка итога, канбан, приём, импорт, слияние. Права роли, тип, варианты, ссылки и почта
// (D-051), `pii: person` у источника без имён (D-052), обязательность по итогу и этапу.
import { fieldsOf, resolveAccess } from './access.js';
import { coerceValue, isEmptyValue, sameValue, type ValueContext } from './values.js';
import type {
  CustomValues,
  FieldChange,
  FieldDef,
  FieldIssue,
  FieldObject,
  FieldValue,
  FieldViewer,
  Transition,
  WriteMode,
} from './types.js';

export interface FieldValidatorInput {
  /** Все поля настроек (global и пространства); проверка берёт поля своего объекта. */
  fields: readonly FieldDef[];
  object: FieldObject;
  mode: WriteMode;
  /** Обязателен для `user`; для `ingest` и `system` роли не проверяются. */
  viewer?: FieldViewer;
  /** По умолчанию — правка (`edit`). */
  transition?: Transition;
  /** Приём: `sources[].allowPersonNames`. false — поля `pii: person` отбрасываются (D-052). */
  allowPersonNames?: boolean;
  /** Приём и импорт по существующему клиенту: дописывать только пустые поля (PROCESS 2.3 п. 3). */
  onlyEmpty?: boolean;
  ctx?: ValueContext;
}

export interface FieldPatchResult {
  /** Нет ошибок: запись можно выполнять. */
  ok: boolean;
  /** Принятые ключи: значение или null (удалить ключ из `custom`). Только реальные изменения. */
  patch: Record<string, FieldValue | null>;
  /** Значения после правки (текущие ⊕ patch). */
  next: Record<string, FieldValue>;
  /** «Было → стало» для ленты. */
  changes: FieldChange[];
  /** Блокируют запись (`user`, `system`). */
  errors: FieldIssue[];
  /** Отброшенные значения (`ingest`): запись идёт без них, отчёт приёма их считает. */
  warnings: FieldIssue[];
}

export interface FieldValidator {
  readonly object: FieldObject;
  validate(patch: Readonly<Record<string, unknown>>, current: CustomValues): FieldPatchResult;
  /** Обязательные поля, пустые в `values`, для перехода валидатора. */
  missingRequired(values: CustomValues): FieldIssue[];
}

function requiredFor(def: FieldDef, t: Transition): boolean {
  if (def.required.always) return true;
  if (t.kind === 'outcome') return def.required.onOutcome.includes(t.outcome);
  if (t.kind === 'stage') return def.required.onStage.includes(t.stage);
  return false;
}

export function buildFieldValidator(input: FieldValidatorInput): FieldValidator {
  if (input.mode === 'user' && !input.viewer) throw new Error('buildFieldValidator: для mode=user нужен viewer');
  const defs = fieldsOf(input.fields, input.object);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const transition: Transition = input.transition ?? { kind: 'edit' };
  const { mode, viewer } = input;

  /** Может ли этот путь писать поле: ошибка для `user`/`system`, предупреждение для `ingest`. */
  function gate(def: FieldDef | undefined, key: string): FieldIssue | null {
    if (!def) return { key, code: mode === 'ingest' ? 'not_ingest' : 'unknown_field' };
    if (mode === 'user') {
      const a = resolveAccess(def, viewer!);
      // Скрытое поле отвечает как несуществующее: ответ не выдаёт состав скрытых полей
      if (a === 'hidden') return { key, code: 'unknown_field' };
      if (a !== 'edit') return { key, code: def.archived ? 'archived' : 'forbidden' };
      return null;
    }
    if (def.archived) return { key, code: 'archived' };
    if (mode === 'ingest') {
      if (!def.ingest) return { key, code: 'not_ingest' };
      if (def.pii === 'person' && input.allowPersonNames === false) return { key, code: 'person_dropped' };
    }
    return null;
  }

  /** Обязательность проверяется только у полей, которые этот сотрудник может заполнить (D-122). */
  function enforceable(def: FieldDef): boolean {
    if (def.archived) return false;
    return mode !== 'user' || resolveAccess(def, viewer!) === 'edit';
  }

  function missingRequired(values: CustomValues): FieldIssue[] {
    return defs
      .filter((d) => enforceable(d) && requiredFor(d, transition) && isEmptyValue(Object.hasOwn(values, d.key) ? values[d.key] : null))
      .map((d) => ({ key: d.key, code: 'required' as const }));
  }

  function validate(raw: Readonly<Record<string, unknown>>, current: CustomValues): FieldPatchResult {
    const errors: FieldIssue[] = [];
    const warnings: FieldIssue[] = [];
    const patch: Record<string, FieldValue | null> = {};
    const changes: FieldChange[] = [];
    // Значения ключей, которых уже нет в настройках, запись не трогает (их не отдаёт projectFor)
    const next: Record<string, FieldValue> = { ...current };

    const sink = mode === 'ingest' ? warnings : errors;
    for (const key of Object.keys(raw)) {
      const def = byKey.get(key);
      const g = gate(def, key);
      if (g) {
        sink.push(g);
        continue;
      }
      const before = Object.hasOwn(current, key) ? current[key]! : null;
      if (input.onlyEmpty && !isEmptyValue(before)) continue;
      const c = coerceValue(def!, raw[key], input.ctx, before);
      if (!c.ok) {
        sink.push({ key, code: c.code });
        continue;
      }
      if (sameValue(before, c.value)) continue;
      patch[key] = c.value;
      changes.push({ key, before, after: c.value });
      if (c.value === null) delete next[key];
      else next[key] = c.value;
    }

    // Правка: нельзя очистить обязательное поле. Итог или этап: все обязательные должны быть заполнены.
    if (transition.kind === 'edit') {
      for (const ch of changes) {
        const def = byKey.get(ch.key)!;
        if (ch.after === null && enforceable(def) && requiredFor(def, transition)) errors.push({ key: ch.key, code: 'required' });
      }
    } else if (mode !== 'ingest') {
      errors.push(...missingRequired(next));
    }

    return { ok: errors.length === 0, patch, next, changes, errors, warnings };
  }

  return { object: input.object, validate, missingRequired };
}
