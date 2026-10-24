'use client';

// Поле «на месте» (D-356, pipeline-v2 §9.6): значение — кнопка; клик, Enter или пробел открывают элемент ввода по типу
// поля, Enter / потеря фокуса с изменением сохраняют одно поле, Esc и ✕ отменяют без запроса. Состояния:
// view → edit → saving → (error | conflict) → view. Компонент не знает адресов: сохранение — `save(next, prev)`.
// Подписи приходят в `texts`; поле без права правки — обычный текст без кнопки и подчёркивания.
import { Check, X } from 'lucide-react';
import { useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/ui/kit';
import type { FieldDraft, FieldPayload } from './draft';
import { FieldControl, type ControlOption } from './FieldControl';
import {
  commitsOnPick,
  displayValue,
  draftFor,
  prepareSave,
  revertDraft,
  stateAfterSave,
  valueFromPayload,
  type InlineOption,
  type InlineState,
} from './inline';
import type { FieldSave } from './save';

export type InlineFieldDef = {
  object: 'client' | 'card';
  key: string;
  type: string;
  label: string;
  options: readonly InlineOption[];
  /** Сервер отдал `access: 'edit'` и у зрителя есть право на объект. */
  editable: boolean;
};

export type InlineTexts = {
  /** «Добавить» — пустое поле с правом правки. */
  add: string;
  /** «Изменить: {label}» / «Добавить: {label}» для вспомогательных технологий. */
  editAria: string;
  addAria: string;
  save: string;
  cancel: string;
  retry: string;
  notChosen: string;
  yes: string;
  no: string;
  /** «Изменил другой сотрудник: «{value}»». */
  conflict: string;
  conflictUnknown: string;
  keepNew: string;
  writeMine: string;
  /** Тексты ошибок: по коду проверки сервера (`type`, `too_long`, `option` …), разбору черновика и ответам. */
  errors: { fields: Record<string, string>; fieldsDefault: string; money: string; number: string; phone: string; invalid: string; forbidden: string; readonly: string; network: string };
  locale?: string;
};

export type InlineFieldProps = {
  field: InlineFieldDef;
  value: unknown;
  save: (next: FieldPayload, prev: unknown) => Promise<FieldSave>;
  texts: InlineTexts;
  /** `row` — подпись слева (сетка 12rem | 1fr), `stack` — подпись над значением, `auto` — стопка на телефоне, ряд от sm. */
  layout?: 'row' | 'stack' | 'auto';
  /** Значение после сохранения или после «Оставить новое»: родитель обновляет данные и ленту. */
  onValue?: (next: unknown) => void;
  /** Конфликт без известного нового значения: родителю нужно перечитать карточку. */
  onRefresh?: () => void;
  /** Показ значения без права правки (ссылка, почта); по умолчанию — текст. */
  readView?: ReactNode;
  className?: string;
};

const LAYOUT: Record<NonNullable<InlineFieldProps['layout']>, string> = {
  row: 'grid grid-cols-[12rem_minmax(0,1fr)] items-baseline gap-x-3',
  stack: 'flex flex-col gap-0.5',
  auto: 'flex flex-col gap-0.5 sm:grid sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-baseline sm:gap-x-3',
};

export function InlineField({ field, value, save, texts, layout = 'auto', onValue, onRefresh, readView, className }: InlineFieldProps) {
  const { object, key, type, label, options } = field;
  const [local, setLocal] = useState<unknown>(value);
  const [state, setState] = useState<InlineState>({ phase: 'view' });
  const [draft, setDraft] = useState<FieldDraft>('');
  const [error, setError] = useState<string | undefined>(undefined);
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const tid = `${object}-${key}`;

  // Данные страницы обновились (лента, другое поле): показываем новое, пока поле не правится
  const [seen, setSeen] = useState<string>(JSON.stringify(value ?? null));
  const incoming = JSON.stringify(value ?? null);
  if (incoming !== seen) {
    setSeen(incoming);
    if (state.phase === 'view' || state.phase === 'locked') setLocal(value);
  }

  const text = displayValue(type, local, { options, yes: texts.yes, no: texts.no, ...(texts.locale ? { locale: texts.locale } : {}) });
  const empty = text === '';
  const editable = field.editable && state.phase !== 'locked';
  const controlOptions: ControlOption[] = options.map((o) => ({ key: o.key, label: o.label, ...(o.archived ? { archived: true } : {}) }));

  const errorText = (s: InlineState): string | undefined => {
    if (s.phase !== 'error') return undefined;
    if (s.reason === 'fields') return texts.errors.fields[s.code ?? ''] ?? texts.errors.fieldsDefault;
    return texts.errors[s.reason];
  };

  const open = () => {
    setDraft(draftFor(type, local));
    setError(undefined);
    setState({ phase: 'edit', draft: draftFor(type, local) });
  };

  const cancel = () => {
    setDraft(revertDraft(type, local));
    setError(undefined);
    setState({ phase: 'view' });
  };

  async function commit(now: FieldDraft, prev: unknown = local) {
    if (busy.current) return;
    const p = prepareSave(type, now, prev);
    if (p.kind === 'unchanged') {
      setState({ phase: 'view' });
      return;
    }
    if (p.kind === 'invalid') {
      setError(texts.errors[p.code]);
      setState({ phase: 'edit', draft: now });
      return;
    }
    busy.current = true;
    setError(undefined);
    setState({ phase: 'saving', draft: now });
    let r: FieldSave;
    try {
      r = await save(p.next, prev);
    } catch {
      r = { ok: false, kind: 'network' };
    }
    busy.current = false;
    const next = stateAfterSave(now, r);
    if (r.ok) {
      const v = valueFromPayload(type, p.next);
      setLocal(v);
      onValue?.(v);
    }
    setState(next);
    if (next.phase === 'error') setError(errorText(next));
    if (r.ok === false && r.kind === 'conflict' && !r.known) onRefresh?.();
  }

  const onPick = (next: FieldDraft) => {
    setDraft(next);
    setError(undefined);
    // Выбор из списка и флажок сохраняются сразу; дата — когда введена целиком (очистка — по потере фокуса)
    if (commitsOnPick(type) && !(type === 'date' && next === '')) void commit(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA') {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        void commit(draft);
      }
      return;
    }
    if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
      e.preventDefault();
      void commit(draft);
    }
  };

  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (state.phase !== 'edit' && state.phase !== 'error') return;
    const to = e.relatedTarget as Node | null;
    if (to && root.current?.contains(to)) return;
    void commit(draft);
  };

  // Кнопки ✓ ✕ не должны отнимать фокус у поля (иначе потеря фокуса сохранит раньше нажатия)
  const keepFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault(), onPointerDown: (e: React.PointerEvent) => e.preventDefault() };

  let body: ReactNode;
  if (state.phase === 'conflict') {
    const cur = displayValue(type, state.current, { options, yes: texts.yes, no: texts.no, ...(texts.locale ? { locale: texts.locale } : {}) });
    body = (
      <div className="flex flex-col gap-2" data-testid={`inline-conflict-${tid}`} role="alert">
        <p className="text-[var(--danger)]">{state.known ? texts.conflict.replace('{value}', cur === '' ? '—' : cur) : texts.conflictUnknown}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="inline-keep-new"
            onClick={() => {
              if (state.known) {
                setLocal(state.current);
                onValue?.(state.current);
              }
              setState({ phase: 'view' });
            }}
          >
            {texts.keepNew}
          </Button>
          <Button type="button" variant="primary" size="sm" className="bg-success text-on-success" data-testid="inline-write-mine" onClick={() => {
              setLocal(state.current);
              void commit(state.draft, state.current);
            }}
          >
            {texts.writeMine}
          </Button>
        </div>
      </div>
    );
  } else if (state.phase === 'edit' || state.phase === 'saving' || state.phase === 'error') {
    const saving = state.phase === 'saving';
    body = (
      <form
        className="flex flex-col gap-2"
        data-testid={`inline-form-${tid}`}
        onSubmit={(e) => {
          e.preventDefault();
          void commit(draft);
        }}
      >
        <fieldset disabled={saving} className="contents">
          <FieldControl
            type={type}
            label={label}
            value={draft}
            onChange={onPick}
            options={controlOptions}
            emptyLabel={texts.notChosen}
            error={error}
            name={`inline-${tid}`}
            autoFocus
            hideLabel
            enterKeyHint="done"
            onKeyDown={onKeyDown}
          />
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" className="bg-success text-on-success" iconOnly aria-label={texts.save} disabled={saving} data-testid="inline-save" {...keepFocus}>
            <Check aria-hidden="true" />
          </Button>
          <Button type="button" variant="secondary" size="sm" iconOnly aria-label={texts.cancel} disabled={saving} data-testid="inline-cancel" onClick={cancel} {...keepFocus}>
            <X aria-hidden="true" />
          </Button>
          {state.phase === 'error' && state.reason === 'network' && (
            <Button type="button" variant="quiet" size="sm" data-testid="inline-retry" onClick={() => void commit(draft)}>
              {texts.retry}
            </Button>
          )}
        </div>
      </form>
    );
  } else if (editable) {
    const aria = (empty ? texts.addAria : texts.editAria).replace('{label}', label);
    body = (
      <button
        type="button"
        className="min-h-11 w-full break-words text-left underline decoration-dotted underline-offset-4 sm:min-h-0"
        style={empty ? { color: 'var(--text-3)' } : undefined}
        aria-label={aria}
        onClick={open}
        data-testid={`inline-open-${tid}`}
      >
        {empty ? texts.add : text}
      </button>
    );
  } else {
    body = (
      <>
        {readView ?? (empty ? <span className="text-[var(--text-2)]">—</span> : text)}
        {state.phase === 'locked' && (
          <p className="text-sm text-[var(--text-2)]" role="status" data-testid={`inline-locked-${tid}`}>
            {texts.errors[state.reason]}
          </p>
        )}
      </>
    );
  }

  return (
    <div ref={root} className={`${LAYOUT[layout]} py-1.5${className ? ` ${className}` : ''}`} data-testid={`inline-${tid}`} onBlur={onBlur}>
      <dt className="text-[var(--text-2)]">{label}</dt>
      <dd className="min-w-0 break-words">{body}</dd>
    </div>
  );
}
