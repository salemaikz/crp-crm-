// «Отсутствует» (PROCESS 7.5, D-041, D-255): какие карточки сотрудника получают временного владельца и кому
// именно. Чистые функции: ни БД, ни часов. Само событие `absence` и его побочные эффекты — в ядре `calling`.
import type { CardState } from '../calling/spec/types';
import type { LocalDay, Ms, UserId } from './types';

/** Карточка отсутствующего (или такая, где он сам временный владелец) — вход выбора. */
export interface AbsenceCardRow {
  cardId: string;
  clientId: string;
  state: CardState;
  callsTotal: number;
  nextCallAt: Ms | null;
  /** Есть запись `registered|confirmed` в окне [max(from, сегодня), следующий рабочий день после to]. */
  hasBookingInWindow: boolean;
  /** Не пусто — отсутствующий замещает владельца карточки: временный меняется, срок остаётся прежним. */
  actingUserId: UserId | null;
  actingUntilDay: LocalDay;
}

export interface AbsenceAction {
  cardId: string;
  action: 'release' | 'acting';
  actingUserId?: UserId;
  untilDay?: LocalDay;
}

/**
 * Какие карточки трогать (PROCESS 7.5, D-255). `endMs` — начало местного дня после `to_day`.
 * - нетронутая `new` (звонков нет) — в пул;
 * - `retry`/`callback` со сроком раньше `endMs` (включая уже наступившие);
 * - `agreed`/`client` с записью в окне — временный увидит напоминание накануне;
 * - карточки, где отсутствующий сам временный (`actingUserId` задан), — любые рабочие, срок прежний;
 * - остальное (закрытые, `new` с историей звонков, перезвон после отсутствия) не трогаем.
 */
export function selectAbsenceCards(rows: readonly AbsenceCardRow[], endMs: Ms): AbsenceCardRow[] {
  return rows.filter((r) => {
    if (r.actingUserId !== null) return isHandedState(r.state);
    switch (r.state) {
      case 'new':
        return r.callsTotal === 0;
      case 'retry':
      case 'callback':
        return r.nextCallAt !== null && r.nextCallAt < endMs;
      case 'agreed':
      case 'client':
        return r.hasBookingInWindow;
      default:
        return false;
    }
  });
}

const isHandedState = (s: CardState): boolean => s === 'retry' || s === 'callback' || s === 'agreed' || s === 'client';

export interface ActingCard {
  cardId: string;
  /** Наименьший `client_id` группы двойников: группа уходит одному человеку целиком (D-174). */
  groupKey: string;
  /** Нетронутая новая: уходит в пул, а не временному. */
  release?: boolean;
  /** Прежний срок (карточка, где отсутствующий замещал коллегу); иначе общий `untilDay`. */
  untilDay?: LocalDay;
}

export type ActingWho = { substitute: UserId } | { even: readonly { userId: UserId; load: number }[] };

/**
 * Временный на каждую карточку: заданный заместитель или «поровну». «Поровну» — группа двойников целиком одному;
 * кому меньше нагрузка (текущая + уже назначенное этим планом), тому раньше; при равенстве — порядок кандидатов.
 * Пустой список кандидатов даёт только `release` (временных назначить некому — сервер ответит `no_substitute`).
 */
export function planActing(cards: readonly ActingCard[], who: ActingWho, untilDay: LocalDay): AbsenceAction[] {
  const out: AbsenceAction[] = [];
  const groups = new Map<string, ActingCard[]>();
  for (const c of cards) {
    if (c.release) {
      out.push({ cardId: c.cardId, action: 'release' });
      continue;
    }
    const g = groups.get(c.groupKey);
    if (g) g.push(c);
    else groups.set(c.groupKey, [c]);
  }
  if ('substitute' in who) {
    for (const g of groups.values()) for (const c of g) out.push({ cardId: c.cardId, action: 'acting', actingUserId: who.substitute, untilDay: c.untilDay ?? untilDay });
    return out;
  }
  if (who.even.length === 0) return out;
  const load = who.even.map((e) => e.load);
  for (const g of groups.values()) {
    let best = 0;
    for (let i = 1; i < load.length; i++) if ((load[i] as number) < (load[best] as number)) best = i;
    const userId = (who.even[best] as { userId: UserId }).userId;
    load[best] = (load[best] as number) + g.length;
    for (const c of g) out.push({ cardId: c.cardId, action: 'acting', actingUserId: userId, untilDay: c.untilDay ?? untilDay });
  }
  return out;
}
