// Текст push (D-033, D-328): только вид события и числа. Шаблоны — messages/ru/push.json; подстановки — только числа
// из params (строки отбрасываются ещё при записи в очередь). Свой маленький форматтер: `{name}` и
// `{name, plural, one {…} few {…} many {…} other {…}}` с `#`; иного синтаксиса в push.json нет (тест).
import messages from '../../../../messages/ru/push.json';

/** Виды, которые уходят push (PROCESS 11). Остальные — только колокол. */
export const PUSH_KINDS = [
  'digest_operator',
  'digest_manager',
  'alarm_callbacks_overdue',
  'alarm_handoff_unaccepted',
  'alarm_grey_unassigned',
  'client_transferred',
  'staff_disabled',
  'consultant_assigned',
  'booking_consult_new',
  'handoff_new',
  'handoff_assigned',
  'task_assigned',
  'grey_suggest',
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** Тревоги и сводки — `high` (будят телефон), остальное — `normal`. */
export const URGENT_PUSH_KINDS: ReadonlySet<string> = new Set(['alarm_callbacks_overdue', 'alarm_handoff_unaccepted', 'alarm_grey_unassigned']);

const MAX_NUMBER = 1e9;

/** Только конечные целые числа в разумных пределах: строки, вложенные объекты и прочее отбрасываются. */
export function numericParams(params: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return out;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (/^[a-z][A-Za-z0-9]{0,31}$/.test(k) && typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_NUMBER) out[k] = v;
  }
  return out;
}

const plural = new Intl.PluralRules('ru');

/** Подставить числа в шаблон. Нет нужного числа или шаблон не разобран — null (вызывающий берёт запасной текст). */
export function formatPushTemplate(tpl: string, args: Readonly<Record<string, number>>): string | null {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const ch = tpl[i]!;
    if (ch === '}') return null;
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    const close = matchBrace(tpl, i);
    if (close < 0) return null;
    const inner = tpl.slice(i + 1, close);
    const m = /^\s*([a-z][A-Za-z0-9]*)\s*(?:,\s*plural\s*,(.*))?$/s.exec(inner);
    if (!m) return null;
    const value = args[m[1]!];
    if (value === undefined) return null;
    if (m[2] === undefined) out += String(value);
    else {
      const branch = pluralBranch(m[2], value);
      if (branch === null || /[{}]/.test(branch)) return null;
      out += branch.replace(/#/g, String(value));
    }
    i = close + 1;
  }
  return out;
}

function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j;
  }
  return -1;
}

/** Ветка plural: `=N` точно, иначе категория ru (`one`, `few`, `many`), иначе `other`. */
function pluralBranch(opts: string, n: number): string | null {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < opts.length) {
    while (i < opts.length && /\s/.test(opts[i]!)) i++;
    if (i >= opts.length) break;
    const key = /^(=\d+|zero|one|two|few|many|other)\s*/.exec(opts.slice(i));
    if (!key) return null;
    i += key[0].length;
    if (opts[i] !== '{') return null;
    const close = matchBrace(opts, i);
    if (close < 0) return null;
    branches.set(key[1]!, opts.slice(i + 1, close));
    i = close + 1;
  }
  return branches.get(`=${n}`) ?? branches.get(plural.select(n)) ?? branches.get('other') ?? null;
}

export interface PushText {
  title: string;
  body: string;
}

/** Текст push по виду и числам. Неизвестный вид или нет чисел — нейтральный запасной текст. */
export function pushTextFor(kind: string, params: unknown): PushText {
  const tpl = (messages.kinds as Record<string, string>)[kind];
  const body = tpl === undefined ? null : formatPushTemplate(tpl, numericParams(params));
  return { title: messages.title, body: body ?? messages.fallback };
}
