// Сопоставление записи с базой по PROCESS 2.3 (правила 3–4) и CONFIG global.dedup.
// Порядок правил [код]: БИН → рабочий номер + название → пара. Флаги включают правила по отдельности.
// Основа: SalemAI 108fb70 src/lib/db/crm/coldMatch.ts (findColdMatch), SQL убран.
// Отличия от SalemAI: правила управляются флагами `dedup.*`; «одно название без руководителя» больше
// не даёт пару (PROCESS 2.3 п. 4: название И руководитель); пара-причина `name_and_head`.
// При сомнении не склеиваем: слияние решает РОП.

import type { CompanyKeys, DedupResult, DedupSettings, DupPair, KnownCompany } from './types';

export interface CompanyIndex {
  /** Классифицировать запись относительно всего, что в индексе. */
  match(who: CompanyKeys): DedupResult;
  /** Добавить компанию (например, только что принятую строку той же партии). */
  add(company: KnownCompany): void;
  readonly size: number;
}

const byAge = (a: KnownCompany, b: KnownCompany) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Индекс по БИН, номерам и названию: поиск за O(1) на ключ, а не обход всей базы (импорт — до 20 000 строк). */
export function createCompanyIndex(known: readonly KnownCompany[], settings: DedupSettings): CompanyIndex {
  const byOrgId = new Map<string, KnownCompany[]>();
  const byPhone = new Map<string, KnownCompany[]>();
  const byStub = new Map<string, KnownCompany[]>();
  const byName = new Map<string, KnownCompany[]>();
  let size = 0;

  const add = (c: KnownCompany) => {
    size++;
    if (c.orgId) push(byOrgId, c.orgId, c);
    for (const p of c.phones) push(byPhone, p, c);
    for (const p of c.stubPhones ?? []) push(byStub, p, c);
    if (c.nameNorm) push(byName, c.nameNorm, c);
  };
  for (const c of known) add(c);

  /** Компании с хотя бы одним из ключей, без повторов, старые первыми. */
  const collect = (map: Map<string, KnownCompany[]>, keys: readonly string[]): KnownCompany[] => {
    const seen = new Map<string, KnownCompany>();
    for (const k of keys) for (const c of map.get(k) ?? []) seen.set(c.id, c);
    return [...seen.values()].sort(byAge);
  };

  const match = (who: CompanyKeys): DedupResult => {
    // 1. БИН.
    if (settings.byOrgId && who.orgId) {
      const same = [...(byOrgId.get(who.orgId) ?? [])].sort(byAge)[0];
      if (same) return { kind: 'duplicate', matchId: same.id, basis: 'org_id' };
    }

    const pairs: DupPair[] = [];
    const paired = new Set<string>();
    const addPair = (id: string, reason: DupPair['reason']) => {
      if (paired.has(id)) return;
      paired.add(id);
      pairs.push({ id, reason });
    };

    // 2. Рабочий номер: то же название (или названия нет у одной из сторон) — тот же клиент,
    //    иначе общий номер (бухгалтер, секретарь, директор нескольких фирм) — спорная пара.
    const byPhones = collect(byPhone, who.phones);
    if (settings.byPhoneAndName) {
      const same = byPhones.find((c) => !who.nameNorm || !c.nameNorm || c.nameNorm === who.nameNorm);
      if (same) return { kind: 'duplicate', matchId: same.id, basis: 'phone_and_name' };
    }
    if (settings.pairs.sharedPhone) for (const c of byPhones) addPair(c.id, 'shared_phone');

    // 3. Название.
    if (who.nameNorm) {
      const named = [...(byName.get(who.nameNorm) ?? [])].sort(byAge);
      // Без рабочего номера (пусто или заглушка) тот же клиент — то же название И та же записанная
      // заглушка или тот же руководитель.
      if (settings.byPhoneAndName && who.phones.length === 0 && named.length > 0) {
        const stubOwners = new Set(collect(byStub, who.stubPhones ?? []).map((c) => c.id));
        const same =
          named.find((c) => stubOwners.has(c.id)) ??
          named.find((c) => !!who.headNorm && c.headNorm === who.headNorm);
        if (same) return { kind: 'duplicate', matchId: same.id, basis: 'stub_name_head' };
      }
      if (settings.pairs.nameAndHead && who.headNorm) {
        for (const c of named) if (c.headNorm === who.headNorm) addPair(c.id, 'name_and_head');
      }
    }

    return pairs.length > 0 ? { kind: 'disputed', pairs } : { kind: 'new' };
  };

  return {
    match,
    add,
    get size() {
      return size;
    },
  };
}

/** Одноразовая классификация без индекса (для приёма по одной записи). */
export function classifyCompany(
  who: CompanyKeys,
  known: readonly KnownCompany[],
  settings: DedupSettings,
): DedupResult {
  return createCompanyIndex(known, settings).match(who);
}
