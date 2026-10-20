// Отношения (ARCHITECTURE §5.1 п. 3, D-016): именованные предикаты из кода с параметрами из
// настроек. Дают чтение объекта отношения плюс закрытый список действий над ним. Список действий
// зашит здесь; пресет может только сузить его (`relations[].actions` — подмножество).
// Сам предикат (SQL) — в src/server/access/scope.ts; здесь только данные и чистые расчёты.
import type { Permission } from './catalog';

export const RELATION_KEYS = ['booked_with_me', 'duty_today', 'handoff_to_my_team', 'handoff_assigned_to_me'] as const;
export type RelationKey = (typeof RELATION_KEYS)[number];

export type RelationSpec = {
  /** Разрешения на чтение, которые отношение даёт над своим объектом. */
  reads: readonly Permission[];
  /** Закрытый список действий над объектом отношения. Пресет может только сузить. */
  actions: readonly Permission[];
};

export const RELATIONS: Readonly<Record<RelationKey, RelationSpec>> = {
  // Консультант: клиент, карточка, сделки, лента, записи — в окне вокруг своей индивидуальной записи.
  booked_with_me: {
    reads: ['card.read', 'client.read', 'deal.read', 'booking.read'],
    actions: ['booking.attend', 'booking.create', 'note.write', 'deal.purchase', 'deal.edit'],
  },
  // Дежурный: гости своего мероприятия в день мероприятия. Карточку и клиента не открывает:
  // имя, компания и хвост номера гостя отдаёт проекция списка гостей, а не scopeSql('client').
  duty_today: {
    reads: ['booking.read'],
    actions: ['booking.attend', 'booking.walk_in'],
  },
  // Руководитель отдела: клиенты, переданные его отделу, с момента передачи; приём, отказ,
  // назначение исполнителя; комментарии к задачам передачи.
  handoff_to_my_team: {
    reads: ['card.read', 'client.read', 'deal.read', 'handoff.read', 'task.read'],
    actions: ['handoff.accept', 'handoff.assign', 'task.write'],
  },
  // Сотрудник отдела: клиенты, где он исполнитель передачи; задачи передачи и комментарии.
  handoff_assigned_to_me: {
    reads: ['card.read', 'client.read', 'deal.read', 'handoff.read', 'task.read'],
    actions: ['task.write'],
  },
};

/** Параметры окна консультанта: дни относительно местной даты записи, включительно. */
export type ConsultantWindow = { fromDays: number; toDays: number };

/**
 * Окно консультанта (PROCESS §8.4) как диапазон дат записи: консультант видит клиента сегодня, если
 * есть его запись с `booking_date` в [from, to]. «С 00:00 дня перед встречей» (fromDays = −1) и
 * «до конца 30-го дня после» (toDays = 30) ⇔ booking_date ∈ [today − toDays, today − fromDays].
 * Строки 'YYYY-MM-DD' сравниваются лексикографически — в SQL достаточно BETWEEN.
 */
export function consultantWindowDates(today: string, w: ConsultantWindow): { from: string; to: string } {
  return { from: addDays(today, -w.toDays), to: addDays(today, -w.fromDays) };
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Сдвиг местной даты на n календарных дней (без поясов: дата — просто дата). */
export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`addDays: ожидалась дата YYYY-MM-DD, получено ${JSON.stringify(day)}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Местная дата момента `now` в поясе `timeZone` ('YYYY-MM-DD'). */
export function localDay(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Проверка имени пояса IANA без исключения наружу. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
