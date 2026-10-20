// Предпросмотр импорта (PROCESS 2.2): что будет с каждой строкой, сколько карточек получит каждый
// оператор, спорные строки и ошибки. Чистая функция без БД: известные клиенты, ранее применённые
// строки, стоп-лист и правила источника приходят параметрами. В отчёт идут номера строк и коды —
// без имён и номеров телефонов (ПДн в отчёт `imports.report` не пишутся).

import { createCompanyIndex } from '../dedup/match';
import type { DedupSettings, DupPair, KnownCompany } from '../dedup/types';
import { evaluateRules, type SourceRule } from '../dedup/rules';
import { applyStopList, type HashFn, type StopListLookup } from '../dedup/stoplist';
import { EMPTY_BOOKING_INDEX, hasBooking, type BookingIndex } from './bookings';
import { resolveOwner, type RowOwner } from './owner';
import { decideReimport, type PriorImportRow } from './reimport';
import type { ImportProfile, ParsedRow } from './types';

export type RowAction =
  /** Нет названия: строка не импортируется. */
  | 'invalid'
  /** Та же строка (ключ строки) уже встретилась выше в этом файле. */
  | 'duplicate_in_file'
  | 'skip_same'
  | 'update_state'
  | 'kept_in_crm'
  | 'rejected_rule'
  | 'stop_list'
  /** Точный дубль существующего клиента: дописать пустые поля и номера, состояние не менять. */
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
  /** Для `merge`: id существующего клиента (или `row:N` — строка выше в этом файле). */
  matchId: string | null;
  pairs: DupPair[];
  outcomeKey: string | null;
  /** «Подтвержден» без записи: «Перезвон: сейчас» и задача «Уточнить договорённость» (PROCESS 3.5 № 30). */
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
}

const ACTIONS: RowAction[] = ['invalid', 'duplicate_in_file', 'skip_same', 'update_state', 'kept_in_crm', 'rejected_rule', 'stop_list', 'merge', 'create'];
const HOLD_ORDER: HoldReason[] = ['rule', 'no_working_phone', 'dup_pair', 'import_conflict'];

export function buildPreview(input: PreviewInput): ImportPreview {
  const index = createCompanyIndex(input.known, input.dedup);
  const baseAge = input.known.reduce((m, c) => Math.max(m, c.createdAt), 0);
  const bookings = input.bookings ?? EMPTY_BOOKING_INDEX;
  const seenKeys = new Set<string>();
  const unmapped = new Set<string>();

  const byAction = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<RowAction, number>;
  const held: Record<HoldReason, number> = { dup_pair: 0, import_conflict: 0, no_working_phone: 0, rule: 0 };
  const noteFlags: Record<string, number> = {};
  const perOperator: Record<string, number> = {};
  let unowned = 0;
  let needReview = 0;
  let agreedWithoutBookingN = 0;

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
    const finish = (action: RowAction): PreviewRow => {
      pr.action = action;
      byAction[action]++;
      if (row.issues.some((i) => i.severity !== 'info')) needReview++;
      for (const f of row.noteFlags) noteFlags[f] = (noteFlags[f] ?? 0) + 1;
      return pr;
    };

    if (row.issues.some((i) => i.code === 'no_name')) return finish('invalid');
    if (seenKeys.has(row.rowKey)) return finish('duplicate_in_file');
    seenKeys.add(row.rowKey);

    // Повтор импорта (D-048): та же пара ключей — пропуск; состояние изменилось — звонок или «оставлено как в CRM».
    const decision = decideReimport(row, input.prior?.get(row.rowKey));
    if (decision === 'skip') return finish('skip_same');
    if (decision === 'update_state') return finish('update_state');
    if (decision === 'kept_in_crm') return finish('kept_in_crm');

    const rule = { legalForm: row.legalForm, region: row.region };
    if (input.rules?.reject && evaluateRules(input.rules.reject, rule)) return finish('rejected_rule');

    // Стоп-лист: номер из списка отбрасывается; не осталось рабочих — запись не создаётся (D-021).
    const stop = applyStopList(row.workingPhones, input.stopList.hash, input.stopList.lookup);
    pr.stoppedPhones = stop.stopped.length;
    if (stop.verdict === 'stop_list') return finish('stop_list');

    const result = index.match({
      orgId: row.orgId,
      phones: stop.allowed,
      stubPhones: row.stubPhones,
      nameNorm: row.nameNorm,
      headNorm: row.headNorm,
    });
    if (result.kind === 'duplicate') {
      pr.matchId = result.matchId;
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

    if (row.outcomeKind === 'agreed' && !hasBooking(row, bookings)) {
      pr.agreedWithoutBooking = true;
      agreedWithoutBookingN++;
    }

    if (!pr.hold) {
      if (pr.ownerUserId) perOperator[pr.ownerUserId] = (perOperator[pr.ownerUserId] ?? 0) + 1;
      else unowned++;
    }

    // Новая строка видна следующим строкам файла: дубль внутри файла не создаст второго клиента.
    index.add({
      id: `row:${row.rowNo}`,
      createdAt: baseAge + row.rowNo,
      orgId: row.orgId,
      phones: stop.allowed,
      stubPhones: row.stubPhones,
      nameNorm: row.nameNorm,
      headNorm: row.headNorm,
    });
    return finish('create');
  });

  return {
    rows: out,
    counts: { total: out.length, byAction, held, needReview, agreedWithoutBooking: agreedWithoutBookingN, noteFlags },
    perOperator,
    unowned,
    unmappedSlots: [...unmapped].sort(),
  };
}
