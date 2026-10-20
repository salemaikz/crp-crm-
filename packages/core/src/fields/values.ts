// Приведение и проверка значения поля по типу (CONFIG §6.11). Одна функция на все пути записи:
// интерфейс, API, приём, импорт, слияние. Ссылки — только http(s), почта — только адрес (D-051).
import { DEFAULT_PHONE_RULES, parsePhone, type PhoneRules } from '../phone/index.js';
import { isValidDay } from '../time/zone.js';
import type { FieldDef, FieldIssueCode, FieldValue } from './types.js';

export const LIMITS = {
  text: 500,
  textarea: 5000,
  url: 2000,
  email: 254,
  multiselect: 50,
  /** Деньги — целые тенге. */
  moneyMax: 1_000_000_000_000,
  numberAbsMax: 1e15,
  /** datetime — epoch-мс до 2100-01-01. */
  datetimeMax: 4_102_444_800_000,
} as const;

export interface ValueContext {
  /** Правила номеров `global.phone`; по умолчанию — правила продукта. */
  phoneRules?: PhoneRules;
  /** Проверка id сотрудника для типа `user` (активный сотрудник установки). Без неё — только форма id. */
  isUser?: (id: string) => boolean;
}

export type Coerced = { ok: true; value: FieldValue | null } | { ok: false; code: FieldIssueCode };

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ok = (value: FieldValue | null): Coerced => ({ ok: true, value });
const bad = (code: FieldIssueCode): Coerced => ({ ok: false, code });

/** Пустое значение = очистить поле. */
export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

function asText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/**
 * Ссылка для хранения и вывода: только `http:`/`https:`, без логина и пароля в адресе, с хостом.
 * Строка без схемы, похожая на домен («example.kz/page»), получает `https://`. Иначе null (D-051).
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > LIMITS.url || CONTROL.test(s) || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  const candidate = hasScheme ? s : /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+([/?#:].*)?$/u.test(s) ? `https://${s}` : null;
  if (!candidate) return null;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return u.href.length > LIMITS.url ? null : u.href;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"'.]+(\.[^\s@<>()[\]\\,;:"'.]+)*\.[\p{L}]{2,}$/u;

/** Адрес почты (нижний регистр) или null: без схем, имён и списков (D-051). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > LIMITS.email || CONTROL.test(s)) return null;
  return EMAIL_RE.test(s) ? s : null;
}

/** Ссылка `mailto:` для вывода проверенного адреса; иначе null. */
export function mailtoHref(raw: unknown): string | null {
  const e = normalizeEmail(raw);
  return e ? `mailto:${e}` : null;
}

function text(raw: unknown, max: number, multiline: boolean): Coerced {
  const t = asText(raw);
  if (t === null) return bad('type');
  if (t.includes('\u0000')) return bad('type');
  let s = t.replace(/\r\n?/g, '\n').trim();
  if (!multiline) s = s.replace(/\s*\n\s*/g, ' ');
  if (CONTROL.test(s)) return bad('type');
  if (!s) return ok(null);
  return s.length > max ? bad('too_long') : ok(s);
}

function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/\s+/g, '').replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
  }
  return null;
}

function optionKeys(def: FieldDef, current: FieldValue | null | undefined): Set<string> {
  const keep = new Set(Array.isArray(current) ? current : typeof current === 'string' ? [current] : []);
  return new Set(def.options.filter((o) => !o.archived || keep.has(o.key)).map((o) => o.key));
}

/**
 * Привести значение к типу поля. Пустое — `{ ok: true, value: null }` (очистить). `current` — текущее
 * значение: архивный вариант списка принимается, только если он уже выбран.
 */
export function coerceValue(def: FieldDef, raw: unknown, ctx: ValueContext = {}, current?: FieldValue | null): Coerced {
  if (isEmptyValue(raw)) return ok(null);
  switch (def.type) {
    case 'text':
      return text(raw, LIMITS.text, false);
    case 'textarea':
      return text(raw, LIMITS.textarea, true);
    case 'number': {
      const n = num(raw);
      if (n === null) return bad('type');
      return Math.abs(n) > LIMITS.numberAbsMax ? bad('range') : ok(n);
    }
    case 'money': {
      const n = num(raw);
      if (n === null || !Number.isInteger(n)) return bad('type');
      return n < 0 || n > LIMITS.moneyMax ? bad('range') : ok(n);
    }
    case 'date':
      return typeof raw === 'string' && isValidDay(raw.trim()) ? ok(raw.trim()) : bad('date');
    case 'datetime': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return bad('type');
      return raw < 0 || raw > LIMITS.datetimeMax ? bad('range') : ok(raw);
    }
    case 'boolean':
      if (typeof raw === 'boolean') return ok(raw);
      if (raw === 'true' || raw === 'false') return ok(raw === 'true');
      return bad('type');
    case 'select': {
      if (typeof raw !== 'string') return bad('type');
      return optionKeys(def, current).has(raw) ? ok(raw) : bad('option');
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return bad('type');
      const allowed = optionKeys(def, current);
      const picked = new Set(raw as string[]);
      if (picked.size > LIMITS.multiselect) return bad('too_long');
      for (const k of picked) if (!allowed.has(k)) return bad('option');
      // Канонический порядок — порядок вариантов в настройках: сравнение «было/стало» без шума
      const ordered = def.options.map((o) => o.key).filter((k) => picked.has(k));
      return ok(ordered.length === 0 ? null : ordered);
    }
    case 'phone': {
      const t = asText(raw);
      if (t === null) return bad('type');
      const p = parsePhone(t, ctx.phoneRules ?? DEFAULT_PHONE_RULES);
      return p?.working && p.digits ? ok(p.digits) : bad('phone');
    }
    case 'email': {
      const e = normalizeEmail(raw);
      return e ? ok(e) : bad('email');
    }
    case 'url': {
      const u = safeHttpUrl(raw);
      return u ? ok(u) : bad('url');
    }
    case 'user': {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return bad('type');
      if (ctx.isUser && !ctx.isUser(raw)) return bad('user');
      return ok(raw);
    }
  }
}

/** Равенство значений (списки сравниваются по элементам). */
export function sameValue(a: FieldValue | null | undefined, b: FieldValue | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => v === y[i]);
  return x === y;
}
