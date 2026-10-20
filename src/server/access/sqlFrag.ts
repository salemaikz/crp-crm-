// SQL-фрагменты доступа. Внутренний модуль src/server/access: текст фрагментов — только константы
// этого слоя и проверенные идентификаторы (псевдонимы), значения всегда уходят параметрами ($n).
// Слой БД принимает только tagged template, поэтому `scoped(sql)` разворачивает фрагменты в один
// шаблон с теми же параметрами — склейки пользовательских строк нет.

const BRAND = Symbol.for('crm.access.sqlFrag');

export class Frag {
  readonly [BRAND] = true;
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}
}

/** По бренду, а не instanceof: модуль может попасть в несколько бандлов Next. */
export function isFrag(v: unknown): v is Frag {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[BRAND] === true;
}

/** Развернуть вложенные фрагменты: strings.length === values.length + 1. */
export function flatten(strings: readonly string[], values: readonly unknown[]): { strings: string[]; values: unknown[] } {
  const outS: string[] = [strings[0] ?? ''];
  const outV: unknown[] = [];
  values.forEach((v, i) => {
    const tail = strings[i + 1] ?? '';
    if (isFrag(v)) {
      outS[outS.length - 1] += v.strings[0] ?? '';
      v.values.forEach((iv, j) => {
        outV.push(iv);
        outS.push(v.strings[j + 1] ?? '');
      });
      outS[outS.length - 1] += tail;
    } else {
      outV.push(v);
      outS.push(tail);
    }
  });
  return { strings: outS, values: outV };
}

/** Фрагмент из шаблона; значения — параметры или другие фрагменты. */
export function frag(strings: TemplateStringsArray, ...values: unknown[]): Frag {
  const f = flatten(strings, values);
  return new Frag(f.strings, f.values);
}

const IDENT_RE = /^[a-z][a-z0-9_]{0,15}$/;

/** Идентификатор (псевдоним таблицы) в текст запроса — только после проверки формы. */
export function ident(name: string): Frag {
  if (!IDENT_RE.test(name) || name.startsWith('acc_')) {
    throw new Error(`доступ: недопустимый псевдоним таблицы ${JSON.stringify(name)}`);
  }
  return new Frag([name], []);
}

/** Константный текст (имя таблицы из ENTITY_TABLES, ключевые слова). Только литералы этого слоя. */
export function constText(text: string): Frag {
  if (!/^[a-z_][a-z0-9_ ]*$/i.test(text)) throw new Error('доступ: константный текст вне белого формата');
  return new Frag([text], []);
}

export const TRUE = new Frag(['TRUE'], []);
export const FALSE = new Frag(['FALSE'], []);

/** OR частей; пусто — FALSE. FALSE-части выбрасываются, TRUE поглощает всё. */
export function anyOf(parts: readonly Frag[]): Frag {
  const live = parts.filter((p) => p !== FALSE);
  if (live.length === 0) return FALSE;
  if (live.includes(TRUE)) return TRUE;
  if (live.length === 1) return live[0] as Frag;
  const strings: string[] = ['('];
  const values: unknown[] = [];
  live.forEach((p, i) => {
    if (i > 0) strings[strings.length - 1] += ' OR ';
    values.push(p);
    strings.push('');
  });
  strings[strings.length - 1] += ')';
  const f = flatten(strings, values);
  return new Frag(f.strings, f.values);
}

/** Шаблон для слоя БД: массив строк с `raw`, как у настоящего TemplateStringsArray. */
export function toTemplate(strings: readonly string[]): TemplateStringsArray {
  return Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray;
}
