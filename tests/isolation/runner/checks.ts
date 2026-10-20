// Чистые проверки прогона изоляции: сравнение ответов и поиск утечек. Без src/** и БД, поэтому
// самопроверка (tests/unit/static-isolation-checks.test.ts) гоняет их на заведомо плохих ответах.

export type Reply = {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Для перенаправлений. */
  location?: string;
};

export type Needle = string | RegExp;

/** Номер в любом написании: +7 709 100 00 01, 8(709)1000001, 7091000001. По десяти значащим цифрам. */
export function phoneNeedle(digits: string): RegExp {
  const tail = digits.replace(/\D/g, '').slice(-10);
  return new RegExp(tail.split('').join('[\\s().\\-\\u00a0]{0,3}'));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Название в тексте и в HTML (амперсанды, кавычки), без учёта регистра. */
export function nameNeedle(name: string): RegExp {
  const html = escapeRe(name).replace(/&/g, '(?:&|&amp;)').replace(/"/g, '(?:"|&quot;)').replace(/'/g, "(?:'|&#x27;|&#39;)").replace(/\s+/g, '\\s+');
  return new RegExp(html, 'i');
}

/** Какие иглы нашлись в тексте. Пустые иглы игнорируются. */
export function leaks(text: string, needles: readonly Needle[]): string[] {
  const found: string[] = [];
  for (const n of needles) {
    if (typeof n === 'string') {
      if (n !== '' && text.includes(n)) found.push(n);
    } else if (n.test(text)) found.push(String(n));
  }
  return found;
}

export const replyText = (r: Reply): string => `${r.body}\n${Object.values(r.headers).join('\n')}\n${r.location ?? ''}`;

/** Утечки в ответе (тело, заголовки, Location). Значения в сообщении не печатаем — только число и номер иглы. */
export function leakViolations(label: string, r: Reply, needles: readonly Needle[]): string[] {
  const found = leaks(replyText(r), needles);
  return found.length ? [`${label}: в ответе найдены данные объекта оператора B (${found.length} совпад., иглы №${found.map((f) => needles.findIndex((n) => String(n) === f) + 1).join(',')})`] : [];
}

/** Тело ответа без id запрошенного объекта: 404 чужого и несуществующего должны совпасть побайтно. */
export function normalizeBody(body: string, ids: readonly string[]): string {
  let out = body;
  for (const id of ids) if (id) out = out.split(id).join('<id>').split(encodeURIComponent(id)).join('<id>');
  return out;
}

const SAME_HEADERS = ['content-type', 'cache-control'];

export type ObjectCase = { foreign: Reply; missing: Reply; foreignId: string; missingId: string };

/** Чужой объект = несуществующий: тот же статус (404), те же тело и существенные заголовки. */
export function notFoundViolations(c: ObjectCase): string[] {
  const v: string[] = [];
  if (c.foreign.status !== 404) v.push(`чужой объект: ждали 404, получили ${c.foreign.status}`);
  if (c.missing.status !== 404) v.push(`несуществующий объект: ждали 404, получили ${c.missing.status}`);
  if (c.foreign.status === c.missing.status) {
    const a = normalizeBody(c.foreign.body, [c.foreignId]);
    const b = normalizeBody(c.missing.body, [c.missingId]);
    if (a !== b) v.push('404 чужого объекта отличается телом от 404 несуществующего (выдаёт, что объект есть)');
    for (const h of SAME_HEADERS) {
      if ((c.foreign.headers[h] ?? '') !== (c.missing.headers[h] ?? '')) v.push(`404 чужого и несуществующего различаются заголовком ${h}`);
    }
  }
  return v;
}

export type Snapshot = Readonly<Record<string, string>>;

/** Снимок таблиц до и после: у чужих объектов и недопустимых попыток данные не меняются. */
export function snapshotViolations(label: string, before: Snapshot, after: Snapshot): string[] {
  const v: string[] = [];
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[t] !== after[t]) v.push(`${label}: таблица ${t} изменилась`);
  }
  return v;
}

/** Статус «сервер упал» не бывает допустимым ответом изоляции. */
export const crashViolations = (label: string, r: Reply): string[] => (r.status >= 500 ? [`${label}: ответ ${r.status}${r.body ? ` — ${r.body.slice(0, 200)}` : ''}`] : []);
