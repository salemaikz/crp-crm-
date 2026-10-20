// Предпросмотр импорта (PROCESS 2.2): что будет с каждой строкой, сколько карточек получит каждый
// оператор, спорные строки и ошибки. Чистая функция без БД: известные клиенты, ранее применённые
// строки, стоп-лист и правила источника приходят параметрами. В отчёт идут номера строк и коды —
// без имён и номеров телефонов (ПДн в отчёт `imports.report` не пишутся).

import { createCompanyIndex } from '../dedup/match';
import type { CompanyKeys, DedupSettings, DupPair, KnownCompany } from '../dedup/types';
import { evaluateRules, type SourceRule } from '../dedup/rules';
import { applyStopList, type HashFn, type StopListLookup } from '../dedup/stoplist';
import { EMPTY_BOOKING_INDEX, hasBooking, type BookingIndex } from './bookings';
import { resolveOwner, type RowOwner } from './owner';
import { orgKeyOf, PERSONAL_ID_PREFIX, type PersonalIdHmac } from './personalId';
import { decideReimport, type PriorImportRow } from './reimport';
import type { ImportProfile, ParsedRow } from './types';

export type RowAction =
  /** Нет названия: строка не импортируется. */
  | 'invalid'
  /**
   * Та же строка (ключ строки) уже встретилась выше в этом файле. Другое состояние (итог, ЛПР, статус,
   * ниша, заметка) — замечание `duplicate_state_differs` и строка на разбор: просьба не теряется.
   */
  | 'duplicate_in_file'
  | 'skip_same'
  | 'update_state'
  | 'kept_in_crm'
  | 'rejected_rule'
  | 'stop_list'
  /**
   * Точный дубль существующего клиента: дописать пустые поля и номера, состояние не менять. Итог
   * «не звонить» или другое состояние, чем у строки выше, — замечание и строка на разбор.
   */
  | 'merge'
  /** Новый клиент (см. `hold`). */
  | 'create';

/** Совпадает с `cards.hold_reason` (ARCHITECTURE 4.3). */
export type HoldReason = 'dup_pair' | 'import_conflict' | 'no_working_phone' | 'rule';

export interface PreviewRow {
  rowNo: number;
  action: RowAction;
  /** Для `create`: почему не идёт в раздачу (первая по приоритету) и все причины. */
  hold: HoldReason | '';
  holds: HoldReason[];
  ownerUserId: string | null;
  ownerKind: RowOwner['kind'] | null;
  /** Для `merge`: id существующего клиента (или `row:N` — строка выше); для `duplicate_in_file` — `row:N`. */
  matchId: string | null;
  pairs: DupPair[];
  outcomeKey: string | null;
  /**
   * «Подтвержден» без записи: «Перезвон: сейчас» и задача «Уточнить договорённость» (PROCESS 3.5 № 30).
   * Считается для `create`, `update_state` и `merge`.
   */
  agreedWithoutBooking: boolean;
  /** Номера из стоп-листа, отброшенные из записи (сколько, без значений). */
  stoppedPhones: number;
  issues: string[];
  noteFlags: string[];
}

export interface PreviewCounts {
  total: number;
  byAction: Record<RowAction, number>;
  held: Record<HoldReason, number>;
  /** Строки с замечаниями уровня review/error — «на разбор» РОП. */
  needReview: number;
  /**
   * Дубли (`duplicate_in_file`, `merge`), которые несут то, что потерялось бы: другое состояние или
   * итог «не звонить». Входят и в `needReview`.
   */
  duplicateConflicts: number;
  agreedWithoutBooking: number;
  /** Сколько строк отмечено по каждому коду заметки (просьбы «не звонить», особые категории). */
  noteFlags: Record<string, number>;
}

export interface ImportPreview {
  rows: PreviewRow[];
  counts: PreviewCounts;
  /** userId → сколько новых карточек (`create` без hold) получит. */
  perOperator: Record<string, number>;
  /** Новые без hold и без владельца (строка вне диапазонов): ждут раздачи из пула. */
  unowned: number;
  /** Ярлыки слотов без учётки: РОП должен сопоставить до «Применить». */
  unmappedSlots: string[];
}

export interface PreviewInput {
  rows: readonly ParsedRow[];
  profile: Pick<ImportProfile, 'ownerBy'>;
  /** Ярлык слота (или значение колонки «оператор») → id учётки. */
  ownerMap: Readonly<Record<string, string | undefined>>;
  known: readonly KnownCompany[];
  dedup: DedupSettings;
  stopList: { hash: HashFn; lookup: StopListLookup };
  rules?: { reject?: readonly SourceRule[]; hold?: readonly SourceRule[] };
  /** Ранее применённые строки по ключу строки. */
  prior?: ReadonlyMap<string, PriorImportRow>;
  bookings?: BookingIndex;
  /**
   * HMAC ИИН (D-052): у строк с `orgIdPersonal` сравнение с базой и между строками идёт только по
   * `iin:<HMAC>` — так же, как ИП лежит в `known`. Открытый ИИН в индекс не попадает. У открытого БИН
   * строки тот же HMAC — псевдоним (`orgIdAliases`): по нему находится строка, скрытая по неуверенности.
   */
  personalIdHmac: PersonalIdHmac;
}

/** Замечания дублей, которые РОП должен увидеть (PROCESS 2.3 п. 3: состояние дубль не меняет). */
export const DUPLICATE_ISSUES = {
  stateDiffers: 'duplicate_state_differs',
  doNotCall: 'duplicate_do_not_call',
  orgIdDiffers: 'duplicate_org_id_differs',
} as const;

/** Ключи номера строки для индекса (D-141). */
type OrgKeys = Required<Pick<CompanyKeys, 'orgId' | 'orgIdAliases' | 'orgIdUncertain'>>;

/** Разные номера: ни один `orgId` не совпал с ключами другой стороны. */
function differentOrg(a: Pick<CompanyKeys, 'orgId' | 'orgIdAliases'>, b: Pick<CompanyKeys, 'orgId' | 'orgIdAliases'>): boolean {
  if (!a.orgId || !b.orgId || a.orgId === b.orgId) return false;
  return !(a.orgIdAliases ?? []).includes(b.orgId) && !(b.orgIdAliases ?? []).includes(a.orgId);
}

const ACTIONS: RowAction[] = ['invalid', 'duplicate_in_file', 'skip_same', 'update_state', 'kept_in_crm', 'rejected_rule', 'stop_list', 'merge', 'create'];
const HOLD_ORDER: HoldReason[] = ['rule', 'no_working_phone', 'dup_pair', 'import_conflict'];

export function buildPreview(input: PreviewInput): ImportPreview {
  const index = createCompanyIndex(input.known, input.dedup);
  const baseAge = input.known.reduce((m, c) => Math.max(m, c.createdAt), 0);
  const bookings = input.bookings ?? EMPTY_BOOKING_INDEX;
  const unmapped = new Set<string>();

  const byAction = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<RowAction, number>;
  const held: Record<HoldReason, number> = { dup_pair: 0, import_conflict: 0, no_working_phone: 0, rule: 0 };
  const noteFlags: Record<string, number> = {};
  const perOperator: Record<string, number> = {};
  let unowned = 0;
  let needReview = 0;
  let agreedWithoutBookingN = 0;
  let duplicateConflicts = 0;
  /** Первая строка файла с данным ключом строки. */
  const firstByKey = new Map<string, ParsedRow>();
  /** Строки файла, добавленные в индекс (`row:N`), — чтобы сравнить состояние при склейке. */
  const addedRows = new Map<string, ParsedRow>();

  const hidden = (digits: string) => `${PERSONAL_ID_PREFIX}${input.personalIdHmac(digits)}`;
  /** Открытые БИН базы по их `iin:<HMAC>`: строится при первой неуверенной строке. */
  let knownBins: Map<string, string> | null = null;
  const knownBinOf = (key: string): string | undefined => {
    if (!knownBins) {
      knownBins = new Map();
      for (const c of input.known) if (c.orgId && !c.orgId.startsWith(PERSONAL_ID_PREFIX)) knownBins.set(hidden(c.orgId), c.orgId);
    }
    return knownBins.get(key);
  };
  let knownById: Map<string, KnownCompany> | null = null;
  const knownOf = (id: string) => (knownById ??= new Map(input.known.map((c) => [c.id, c]))).get(id);
  const orgMemo = new Map<ParsedRow, OrgKeys>();
  /**
   * Ключи номера (D-141). Открытый БИН — с псевдонимом `iin:<HMAC>`. Неуверенно скрытый номер, который
   * открыт у клиента базы, — это БИН: дальше он сравнивается открыто. Иначе остаётся скрытым и
   * помечается `orgIdUncertain`; совпадение с открытым БИН строки файла найдёт её псевдоним.
   */
  const orgOf = (row: ParsedRow): OrgKeys => {
    const memo = orgMemo.get(row);
    if (memo) return memo;
    const key = orgKeyOf(row, input.personalIdHmac);
    let keys: OrgKeys;
    if (!key) keys = { orgId: null, orgIdAliases: [], orgIdUncertain: false };
    else if (!row.orgIdPersonal) keys = { orgId: key, orgIdAliases: [hidden(key)], orgIdUncertain: false };
    else if (!row.orgIdUncertain) keys = { orgId: key, orgIdAliases: [], orgIdUncertain: false };
    else {
      const bin = knownBinOf(key);
      keys = bin ? { orgId: bin, orgIdAliases: [key], orgIdUncertain: false } : { orgId: key, orgIdAliases: [], orgIdUncertain: true };
    }
    orgMemo.set(row, keys);
    return keys;
  };

  const out: PreviewRow[] = input.rows.map((row) => {
    const pr: PreviewRow = {
      rowNo: row.rowNo,
      action: 'create',
      hold: '',
      holds: [],
      ownerUserId: null,
      ownerKind: null,
      matchId: null,
      pairs: [],
      outcomeKey: row.outcomeKey,
      agreedWithoutBooking: false,
      stoppedPhones: 0,
      issues: row.issues.map((i) => i.code),
      noteFlags: row.noteFlags,
    };
    const extra: string[] = [];
    const finish = (action: RowAction): PreviewRow => {
      pr.action = action;
      byAction[action]++;
      if (extra.length > 0) {
        pr.issues.push(...extra);
        duplicateConflicts++;
      }
      if (extra.length > 0 || row.issues.some((i) => i.severity !== 'info')) needReview++;
      for (const f of row.noteFlags) noteFlags[f] = (noteFlags[f] ?? 0) + 1;
      return pr;
    };
    /**
     * Дубль несёт другое состояние или «не звонить» — не теряем молча (PROCESS 2.3 п. 3). `other` —
     * ключи номера той стороны (строки выше или клиента базы).
     */
    const flagDuplicate = (earlier: ParsedRow | undefined, other: Pick<CompanyKeys, 'orgId' | 'orgIdAliases'> | undefined) => {
      if (earlier && earlier.stateKey !== row.stateKey) extra.push(DUPLICATE_ISSUES.stateDiffers);
      // Разные БИН/ИИН (тот же ключ строки или склейка неуверенного номера по номеру и названию):
      // возможно, разные лица — РОП разводит вручную.
      if (other && differentOrg(org, other)) extra.push(DUPLICATE_ISSUES.orgIdDiffers);
      if (row.outcomeKind === 'do_not_call' && earlier?.outcomeKind !== 'do_not_call') extra.push(DUPLICATE_ISSUES.doNotCall);
    };
    const org = orgOf(row);
    const markAgreed = () => {
      if (row.outcomeKind === 'agreed' && !hasBooking({ orgId: org.orgId, workingPhones: row.workingPhones }, bookings)) {
        pr.agreedWithoutBooking = true;
        agreedWithoutBookingN++;
      }
    };

    if (row.issues.some((i) => i.code === 'no_name')) return finish('invalid');
    const first = firstByKey.get(row.rowKey);
    if (first) {
      pr.matchId = `row:${first.rowNo}`;
      flagDuplicate(first, orgOf(first));
      return finish('duplicate_in_file');
    }
    firstByKey.set(row.rowKey, row);

    // Повтор импорта (D-048): та же пара ключей — пропуск; состояние изменилось — звонок или «оставлено как в CRM».
    const decision = decideReimport(row, input.prior?.get(row.rowKey));
    if (decision === 'skip') return finish('skip_same');
    if (decision === 'update_state') {
      markAgreed();
      return finish('update_state');
    }
    if (decision === 'kept_in_crm') return finish('kept_in_crm');

    const rule = { legalForm: row.legalForm, region: row.region };
    if (input.rules?.reject && evaluateRules(input.rules.reject, rule)) return finish('rejected_rule');

    // Стоп-лист: номер из списка отбрасывается; не осталось рабочих — запись не создаётся (D-021).
    const stop = applyStopList(row.workingPhones, input.stopList.hash, input.stopList.lookup);
    pr.stoppedPhones = stop.stopped.length;
    if (stop.verdict === 'stop_list') return finish('stop_list');

    const result = index.match({
      ...org,
      legalForm: row.legalForm,
      phones: stop.allowed,
      stubPhones: row.stubPhones,
      nameNorm: row.nameNorm,
      headNorm: row.headNorm,
    });
    if (result.kind === 'duplicate') {
      pr.matchId = result.matchId;
      // С клиентом из базы состояние не сравнить: на разбор идут «не звонить» и другой номер.
      const earlier = addedRows.get(result.matchId);
      flagDuplicate(earlier, earlier ? orgOf(earlier) : knownOf(result.matchId));
      markAgreed();
      return finish('merge');
    }

    const holds = new Set<HoldReason>();
    if (input.rules?.hold && evaluateRules(input.rules.hold, rule)) holds.add('rule');
    if (stop.allowed.length === 0) holds.add('no_working_phone');
    if (result.kind === 'disputed') {
      holds.add('dup_pair');
      pr.pairs = result.pairs;
    }

    const owner = resolveOwner(row.rowNo, row.operatorLabel, input.profile.ownerBy, input.ownerMap);
    pr.ownerKind = owner.kind;
    if (owner.kind === 'assigned') pr.ownerUserId = owner.userId;
    if (owner.kind === 'conflict' || owner.kind === 'unmapped') {
      holds.add('import_conflict');
      if (owner.kind === 'unmapped') for (const l of owner.slots) unmapped.add(l);
    }

    pr.holds = HOLD_ORDER.filter((h) => holds.has(h));
    pr.hold = pr.holds[0] ?? '';
    for (const h of pr.holds) held[h]++;

    markAgreed();

    if (!pr.hold) {
      if (pr.ownerUserId) perOperator[pr.ownerUserId] = (perOperator[pr.ownerUserId] ?? 0) + 1;
      else unowned++;
    }

    // Новая строка видна следующим строкам файла: дубль внутри файла не создаст второго клиента.
    const id = `row:${row.rowNo}`;
    addedRows.set(id, row);
    index.add({
      id,
      createdAt: baseAge + row.rowNo,
      ...org,
      legalForm: row.legalForm,
      phones: stop.allowed,
      stubPhones: row.stubPhones,
      nameNorm: row.nameNorm,
      headNorm: row.headNorm,
    });
    return finish('create');
  });

  return {
    rows: out,
    counts: { total: out.length, byAction, held, needReview, duplicateConflicts, agreedWithoutBooking: agreedWithoutBookingN, noteFlags },
    perOperator,
    unowned,
    unmappedSlots: [...unmapped].sort(),
  };
}
