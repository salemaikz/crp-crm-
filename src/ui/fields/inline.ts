// Чистая часть ввода поля на месте (D-356): черновик, разбор денег, чисел и номера, решение «сохранять ли», показ
// значения и переходы состояний. Без React и сети: проверяется unit-тестами.
import { expectOf, isEmptyValue, type FieldDraft, type FieldPayload } from './draft';
import type { FieldSave } from './save';

/** Типы, которые правятся на месте. `datetime` и `user` — только чтение и форма «Изменить все». */
export const INLINE_TYPES = ['text', 'textarea', 'email', 'url', 'number', 'money', 'phone', 'select', 'multiselect', 'boolean', 'date'] as const;
export type InlineType = (typeof INLINE_TYPES)[number];

export function isInlineType(type: string): type is InlineType {
  return (INLINE_TYPES as readonly string[]).includes(type);
}

/** Сохраняется сразу после выбора, без Enter и потери фокуса. Дата сюда не входит: см. `commitsOnChange`. */
export function commitsOnPick(type: string): boolean {
  return type === 'select' || type === 'boolean';
}

/**
 * Сохранять ли на событие change. Нативная дата в Chrome и Edge присылает change после каждой цифры года
 * («0002-10-24»), поэтому дата уходит, только когда введена целиком и год не короче реального (от 1900);
 * иначе — Enter, потеря фокуса или ✓, как у текста.
 */
export function commitsOnChange(type: string, next: FieldDraft): boolean {
  if (type === 'date') {
    if (typeof next !== 'string') return false;
    const m = /^(\d{4})-\d{2}-\d{2}$/.exec(next);
    return !!m && Number(m[1]) >= 1900;
  }
  return commitsOnPick(type);
}

export type ParseCode = 'money' | 'number' | 'phone';
export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ParseCode };

const SPACES = /[\s  ]/g;

/** Деньги: только целые тенге. «150 000» → 150000; копейки, буквы, минус — ошибка. Пусто → null. */
export function parseMoney(raw: string): Parsed<number | null> {
  const s = raw.replace(SPACES, '').replace(/(₸|тг\.?|kzt)$/i, '');
  if (s === '') return { ok: true, value: null };
  if (!/^\d{1,15}$/.test(s)) return { ok: false, code: 'money' };
  return { ok: true, value: Number(s) };
}

/** Число: запятая и точка — десятичный разделитель, пробелы-разделители тысяч отбрасываются. Пусто → null. */
export function parseNumber(raw: string): Parsed<number | null> {
  const s = raw.replace(SPACES, '').replace(',', '.');
  if (s === '') return { ok: true, value: null };
  if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(s)) return { ok: false, code: 'number' };
  return { ok: true, value: Number(s) };
}

/** Номер: 10 цифр после +7 (допустимы 7 или 8 в начале). Результат — «7XXXXXXXXXX», как хранит сервер. Пусто → null. */
export function parsePhoneInput(raw: string): Parsed<string | null> {
  const d = raw.replace(/\D/g, '');
  if (d === '') return { ok: true, value: null };
  const national = d.length === 11 && (d[0] === '7' || d[0] === '8') ? d.slice(1) : d.length === 10 ? d : null;
  return national === null ? { ok: false, code: 'phone' } : { ok: true, value: `7${national}` };
}

/** Маска при вводе: «+7 7xx xxx xx xx». Лишнее после десяти цифр отбрасывается; ведущие 7/8 — код страны. */
export function maskPhone(raw: string): string {
  const all = raw.replace(/\D/g, '');
  if (all === '') return '';
  // Код страны: после «+», при 11 цифрах с 7/8 и при единственной первой цифре 7/8; иначе цифры — уже номер
  const hasCode = (/^\s*\+/.test(raw) && all[0] === '7') || (all.length >= 11 && (all[0] === '7' || all[0] === '8')) || (all.length === 1 && (all[0] === '7' || all[0] === '8'));
  const d = (hasCode ? all.slice(1) : all).slice(0, 10);
  const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
  return `+7${parts.length ? ` ${parts.join(' ')}` : ''}`;
}

/** Разряды тысяч обычным пробелом: 150000 → «150 000» (для поля ввода; показ с «₸» — `displayValue`). */
export function groupDigits(n: number | string): string {
  const s = String(n);
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return s;
  return `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${m[3] ? m[3].replace('.', ',') : ''}`;
}

/** Черновик для поля ввода из значения: деньги и номер — в виде, привычном глазу. */
export function draftFor(type: string, value: unknown): FieldDraft {
  if (type === 'boolean') return value === true;
  if (type === 'multiselect') return Array.isArray(value) ? value.map(String) : [];
  if (isEmptyValue(value) || typeof value === 'object') return '';
  if (type === 'money' && (typeof value === 'number' || typeof value === 'string')) return groupDigits(value);
  if (type === 'number' && typeof value === 'number') return groupDigits(value).replace(/ /g, '');
  if (type === 'phone') return maskPhone(String(value));
  return String(value);
}

export type Prepared =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; code: ParseCode }
  | { kind: 'save'; next: FieldPayload };

/** Тело запроса из черновика: деньги и числа уходят строкой (сервер приводит тип), номер — «7XXXXXXXXXX». */
export function payloadFor(type: string, draft: FieldDraft): Parsed<FieldPayload> {
  if (typeof draft === 'boolean') return { ok: true, value: draft };
  if (Array.isArray(draft)) return { ok: true, value: draft.length > 0 ? draft : null };
  if (type === 'money') {
    const r = parseMoney(draft);
    return r.ok ? { ok: true, value: r.value === null ? null : String(r.value) } : r;
  }
  if (type === 'number') {
    const r = parseNumber(draft);
    return r.ok ? { ok: true, value: r.value === null ? null : String(r.value) } : r;
  }
  if (type === 'phone') return parsePhoneInput(draft);
  const s = draft.trim();
  return { ok: true, value: s === '' ? null : s };
}

function comparable(v: unknown): string | null {
  const e = expectOf(v);
  if (e === null) return null;
  if (Array.isArray(e)) return e.join('\u0000');
  return String(e);
}

/**
 * Что делать с черновиком при Enter, выборе или потере фокуса. Не изменилось — ничего не отправляем (запроса нет).
 * Изменилось, но не разбирается (деньги с копейками, короткий номер) — ошибка на месте, запроса нет.
 */
export function prepareSave(type: string, draft: FieldDraft, prev: unknown): Prepared {
  const p = payloadFor(type, draft);
  if (!p.ok) return { kind: 'invalid', code: p.code };
  // Булево «нет» и «не задано» для сервера различаются: сравниваем как есть
  if (comparable(p.value) === comparable(prev)) return { kind: 'unchanged' };
  return { kind: 'save', next: p.value };
}

/** «Сохранять ли при потере фокуса» — только при изменении (и при ошибке разбора, чтобы показать её). */
export function shouldSaveOnBlur(type: string, draft: FieldDraft, prev: unknown): boolean {
  return prepareSave(type, draft, prev).kind !== 'unchanged';
}

/** Esc и ✕: черновик возвращается к прежнему значению. */
export function revertDraft(type: string, prev: unknown): FieldDraft {
  return draftFor(type, prev);
}

/** Значение поля после успешного сохранения: деньги и числа в значении — числа, как отдаёт сервер. */
export function valueFromPayload(type: string, next: FieldPayload): unknown {
  if ((type === 'money' || type === 'number') && typeof next === 'string') return Number(next);
  return next;
}

export type InlineOption = { key: string; label: string; archived?: boolean };

/** Показ значения: деньги «150 000 ₸» (narrowSymbol), номер с маской, дата дд.мм.гггг, список — подписью. */
export function displayValue(
  type: string,
  value: unknown,
  opts: { options?: readonly InlineOption[]; yes: string; no: string; locale?: string },
): string {
  if (isEmptyValue(value)) return '';
  const locale = opts.locale ?? 'ru-RU';
  const label = (k: string) => opts.options?.find((o) => o.key === k)?.label ?? k;
  switch (type) {
    case 'boolean':
      return value === true ? opts.yes : opts.no;
    case 'money': {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value);
      return new Intl.NumberFormat(locale, { style: 'currency', currency: 'KZT', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }).format(n);
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(n) : String(value);
    }
    case 'phone':
      return maskPhone(String(value));
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value);
    }
    case 'select':
      return label(String(value));
    case 'multiselect':
      return (Array.isArray(value) ? value : []).map((k) => label(String(k))).join(', ');
    default:
      return String(value);
  }
}

// ---------- Состояния ----------

export type InlineState =
  | { phase: 'view' }
  | { phase: 'edit'; draft: FieldDraft; error?: string }
  | { phase: 'saving'; draft: FieldDraft }
  /** Ошибка сохранения: `reason` — ключ текста, черновик остаётся (нет сети — «Повторить»). */
  | { phase: 'error'; draft: FieldDraft; reason: 'fields' | 'invalid' | 'network'; code?: string }
  /** Поле изменил другой сотрудник: `current` — его значение, `draft` — моё. */
  | { phase: 'conflict'; draft: FieldDraft; current: unknown; known: boolean }
  /** Права на поле нет (403/404/423): поле становится только для чтения. */
  | { phase: 'locked'; reason: 'forbidden' | 'readonly' };

/** Переход после ответа сервера. Успех возвращает `view` — значение обновляет вызывающий. */
export function stateAfterSave(draft: FieldDraft, r: FieldSave): InlineState {
  if (r.ok) return { phase: 'view' };
  switch (r.kind) {
    case 'conflict':
      return { phase: 'conflict', draft, current: r.current, known: r.known };
    case 'forbidden':
    case 'readonly':
      return { phase: 'locked', reason: r.kind };
    case 'fields':
      return { phase: 'error', draft, reason: 'fields', ...(r.code ? { code: r.code } : {}) };
    case 'invalid':
      return { phase: 'error', draft, reason: 'invalid' };
    case 'network':
      return { phase: 'error', draft, reason: 'network' };
  }
}
