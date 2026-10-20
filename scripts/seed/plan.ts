// План сида без времени и БД: кто из клиентов в каком состоянии, с какими номерами, контактами и историей звонков.
// Чистая функция от зерна: тесты проверяют состав, run.ts переводит план в строки таблиц.
import { DISTRICTS, FIRST_NAMES, LAST_NAMES, POSITIONS, REGIONS, STREETS, BRAND_WORDS, SECTOR_WORDS } from './data';
import { Rng } from './rng';

export type PlanKind =
  | 'new_owned'
  | 'new_pool'
  | 'retry'
  | 'callback'
  | 'agreed'
  | 'client'
  | 'not_interested'
  | 'not_target'
  | 'do_not_call'
  | 'written_off';

/** Доли состояний: сумма 1. Остаток от округления уходит в «новые у оператора». */
export const RATIOS: ReadonlyArray<readonly [PlanKind, number]> = [
  ['new_owned', 0.28],
  ['new_pool', 0.12],
  ['retry', 0.18],
  ['callback', 0.14],
  ['agreed', 0.08],
  ['client', 0.02],
  ['not_interested', 0.07],
  ['not_target', 0.05],
  ['do_not_call', 0.02],
  ['written_off', 0.04],
];

export type OutcomeKind = 'no_answer' | 'bad_number' | 'callback' | 'agreed' | 'not_interested' | 'not_target' | 'do_not_call';

/** Звонок истории: `daysAgo` — сколько местных суток назад (≥ 1), время — часы и минуты рабочего окна. */
export interface CallPlan {
  kind: OutcomeKind;
  daysAgo: number;
  hour: number;
  minute: number;
  lpr: '' | 'yes' | 'no';
  durationSec: number | null;
}

export type Agreement = 'group' | 'individual' | 'grey' | 'task';

export interface PhonePlan {
  digits: string;
  working: boolean;
  primary: boolean;
  whatsapp: 'yes' | 'no' | 'unknown';
  /** Принадлежит первому контакту. */
  ofContact: boolean;
}

export interface ContactPlan {
  name: string;
  position: string;
  decisionMaker: boolean;
}

export interface ClientPlan {
  index: number;
  kind: PlanKind;
  /** Номер внутри своего вида: по нему выбираются варианты. */
  ordinal: number;
  clientKind: 'company' | 'person';
  legalForm: 'too' | 'ip' | 'ao' | '';
  name: string;
  region: string;
  address: string;
  /** Случайные числа для полей-справочников и кода ОКЭД: run.ts берёт варианты по модулю из настроек. */
  rand: { niche: number; size: number; district: number; oked: string; withNiche: boolean };
  headName: string;
  phones: PhonePlan[];
  contacts: ContactPlan[];
  /** Индекс оператора (0…operators−1) или null (пул). */
  owner: number | null;
  calls: CallPlan[];
  /** Дней от «сегодня» до следующего звонка и час; null — перезвона нет. */
  nextCall: { dayOffset: number; hour: number; minute: number } | null;
  /** Через сколько суток после последнего звонка карточка вернётся в обзвон (не интересует). */
  returnAfterDays: number | null;
  agreement: Agreement | null;
  /** Номер для выбора причины: reasonPick % число причин вида из настроек. */
  reasonPick: number;
  /** 'reason' — причина вида итога из настроек; иначе готовый код (no_answer_limit, no_working_phone); '' — не закрыта. */
  closeReason: '' | 'reason' | 'no_answer_limit' | 'no_working_phone';
  /** Для «Клиент»: сколько прошедших четвергов назад была явка (0 — ближайший). */
  pastEvent: number | null;
  /** Не интересует с неявкой на прошедший БР. */
  pastNoShow: boolean;
}

export interface PlanOptions {
  seed: string;
  clients: number;
  operators: number;
}

export function quotas(n: number): Map<PlanKind, number> {
  const out = new Map<PlanKind, number>();
  let used = 0;
  for (const [k, r] of RATIOS) {
    const c = Math.floor(n * r);
    out.set(k, c);
    used += c;
  }
  out.set('new_owned', (out.get('new_owned') ?? 0) + (n - used));
  return out;
}

const person = (rng: Rng): string => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;

/** Номер +7 709 …: после кода цифра 2–9 (служебные номера сотрудников начинаются с 1), без заглушек. */
export function clientDigits(rng: Rng, taken: Set<string>): string {
  for (;;) {
    const tail = String(rng.int(2, 9)) + String(rng.int(0, 999999)).padStart(6, '0');
    const digits = `7709${tail}`;
    if (taken.has(digits) || /^(\d)\1{6,}$/.test(tail)) continue;
    taken.add(digits);
    return digits;
  }
}

function callsFor(kind: PlanKind, ordinal: number, rng: Rng): { calls: CallPlan[]; nextCall: ClientPlan['nextCall']; closeReason: ClientPlan['closeReason']; returnAfterDays: number | null } {
  const at = () => ({ hour: rng.int(9, 17), minute: rng.pick([0, 10, 20, 30, 40, 50]) });
  const call = (k: OutcomeKind, daysAgo: number, lpr: CallPlan['lpr'] = '', talked = false): CallPlan => ({
    kind: k,
    daysAgo,
    ...at(),
    lpr,
    durationSec: talked ? rng.int(40, 420) : null,
  });
  switch (kind) {
    case 'retry': {
          // Время повтора считает run.ts по правилу из PROCESS 3.4 от времени последнего звонка
      if (ordinal % 3 === 2) return { calls: [call('no_answer', 2), call('no_answer', 1)], nextCall: null, closeReason: '', returnAfterDays: null };
      return { calls: [call('no_answer', 1)], nextCall: null, closeReason: '', returnAfterDays: null };
    }
    case 'callback': {
      const slot = ordinal % 14; // 5 из 14 — сегодня, 5 — завтра, 4 — позже
      const dayOffset = slot < 5 ? 0 : slot < 10 ? 1 : 2 + (slot % 3);
      return { calls: [call('callback', 1 + (ordinal % 3), 'yes', true)], nextCall: { dayOffset, hour: rng.int(10, 17), minute: rng.pick([0, 15, 30, 45]) }, closeReason: '', returnAfterDays: null };
    }
    case 'agreed':
      return { calls: [call('agreed', 1 + (ordinal % 5), 'yes', true)], nextCall: null, closeReason: '', returnAfterDays: null };
    case 'client':
      return { calls: [call('callback', 36 + (ordinal % 4), 'yes', true), call('agreed', 31 + (ordinal % 3), 'yes', true)], nextCall: null, closeReason: '', returnAfterDays: null };
    case 'not_interested':
      return { calls: [call('not_interested', 2 + (ordinal % 18), ordinal % 2 ? 'yes' : 'no', true)], nextCall: null, closeReason: 'reason', returnAfterDays: null };
    case 'not_target':
      return { calls: [call('not_target', 3 + (ordinal % 20), 'no', true)], nextCall: null, closeReason: 'reason', returnAfterDays: null };
    case 'do_not_call':
      return { calls: [call('do_not_call', 2 + (ordinal % 10), 'no', true)], nextCall: null, closeReason: 'reason', returnAfterDays: null };
    case 'written_off':
      // 3 из 5 — три недозвона подряд; остальные — номер не работает
      if (ordinal % 5 < 3) return { calls: [call('no_answer', 7), call('no_answer', 5), call('no_answer', 3)], nextCall: null, closeReason: 'no_answer_limit', returnAfterDays: null };
      return { calls: [call('bad_number', 2 + (ordinal % 6))], nextCall: null, closeReason: 'no_working_phone', returnAfterDays: null };
    default:
      return { calls: [], nextCall: null, closeReason: '', returnAfterDays: null };
  }
}

export function buildPlan(opts: PlanOptions): ClientPlan[] {
  const rng = new Rng(`plan|${opts.seed}`);
  const q = quotas(opts.clients);
  const kinds: PlanKind[] = [];
  for (const [k, c] of q) for (let i = 0; i < c; i++) kinds.push(k);
  const order = rng.shuffle(kinds);
  const taken = new Set<string>();
  const ordinals = new Map<PlanKind, number>();
  const usedNames = new Set<string>();
  const out: ClientPlan[] = [];

  for (let index = 0; index < order.length; index++) {
    const kind = order[index] as PlanKind;
    const ordinal = ordinals.get(kind) ?? 0;
    ordinals.set(kind, ordinal + 1);
    const num = String(index + 1).padStart(3, '0');

    // Вид клиента: 70% ТОО, 5% АО, 20% ИП, 5% физлицо
    const roll = rng.int(1, 100);
    const clientKind: 'company' | 'person' = roll > 95 ? 'person' : 'company';
    const legalForm: ClientPlan['legalForm'] = clientKind === 'person' ? '' : roll <= 70 ? 'too' : roll <= 75 ? 'ao' : 'ip';
    const brand = `${rng.pick(BRAND_WORDS)} ${rng.pick(SECTOR_WORDS)} ${num}`;
    // Названия уникальны (иначе приложение сочтёт пары дублями): ФИО подбирается, пока имя не станет свободным
    let head = person(rng);
    const nameOf = (h: string): string => (clientKind === 'person' ? h : legalForm === 'ip' ? `ИП ${h}` : `${legalForm === 'ao' ? 'АО' : 'ТОО'} «${brand}»`);
    while (usedNames.has(nameOf(head))) head = person(rng);
    const name = nameOf(head);
    usedNames.add(name);

    const phoneCount = rng.int(1, 100) <= 25 ? 2 : 1;
    const bad = kind === 'written_off' && ordinal % 5 >= 3;
    const phones: PhonePlan[] = [];
    for (let p = 0; p < phoneCount; p++) {
      phones.push({
        digits: clientDigits(rng, taken),
        working: !bad,
        primary: p === 0,
        whatsapp: rng.pick(['yes', 'no', 'unknown'] as const),
        ofContact: p === 0,
      });
    }

    const contacts: ContactPlan[] = [{ name: head, position: rng.pick(POSITIONS), decisionMaker: true }];
    if (rng.int(1, 100) <= 20) contacts.push({ name: person(rng), position: rng.pick(POSITIONS), decisionMaker: false });

    // Владелец — по номеру внутри вида: каждый вид делится между операторами поровну
    const owner = kind === 'new_pool' ? null : ordinal % opts.operators;
    const h = callsFor(kind, ordinal, rng);
    const agreement: Agreement | null = kind === 'agreed' ? (['group', 'group', 'group', 'group', 'group', 'group', 'group', 'individual', 'grey', 'task'] as const)[ordinal % 10] ?? 'group' : null;

    out.push({
      index,
      kind,
      ordinal,
      clientKind,
      legalForm,
      name,
      region: rng.pick(REGIONS),
      address: `${rng.pick(STREETS)}, ${rng.int(1, 120)}`,
      rand: {
        niche: rng.int(0, 99),
        size: rng.int(0, 99),
        district: rng.int(0, DISTRICTS.length - 1),
        oked: `${String(rng.int(1, 96)).padStart(2, '0')}.${rng.int(10, 99)}`,
        withNiche: kind === 'agreed' || kind === 'client' || rng.int(1, 100) <= 80,
      },
      headName: head,
      phones,
      contacts,
      owner,
      calls: h.calls,
      nextCall: h.nextCall,
      returnAfterDays: kind === 'not_interested' ? [30, 60, 90][ordinal % 3] ?? 30 : null,
      agreement,
      reasonPick: ordinal,
      closeReason: h.closeReason,
      pastEvent: kind === 'client' ? ordinal % 3 : null,
      pastNoShow: kind === 'not_interested' && ordinal % 4 === 0,
    });
  }
  return out;
}
