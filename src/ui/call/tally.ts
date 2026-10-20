// Сводка «Сегодня» и темп «звонков в час» на устройстве. Считается по тому, что оператор сделал на этом
// телефоне за местные сутки: без запроса к серверу и без ПДн (только вид итога и время). Сводка по всем
// устройствам — у руководителя. Хранилище — localStorage (синхронно, переживает перезапуск).
import { CONNECTED_KINDS, type OutcomeKind } from './types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TallyItem {
  opId: string;
  kind: OutcomeKind;
  /** Момент нажатия «Позвонить» (темп считается по нему). */
  at: number;
  /** Запись состоялась через мастер записи. */
  booked: boolean;
}

export interface Tally {
  day: string;
  items: TallyItem[];
}

export interface TallyView {
  outcomes: number;
  connected: number;
  booked: number;
}

const MAX_ITEMS = 1000;
const key = (userId: string) => `crm.call.tally.${userId}`;

export function readTally(storage: StorageLike, userId: string, day: string): Tally {
  try {
    const raw = storage.getItem(key(userId));
    if (raw) {
      const t = JSON.parse(raw) as Tally;
      if (t && t.day === day && Array.isArray(t.items)) return t;
    }
  } catch {
    // повреждённая запись — начинаем сутки заново
  }
  return { day, items: [] };
}

function write(storage: StorageLike, userId: string, t: Tally): Tally {
  const next = { day: t.day, items: t.items.slice(-MAX_ITEMS) };
  try {
    storage.setItem(key(userId), JSON.stringify(next));
  } catch {
    // нет места или приватный режим: сводка не критична
  }
  return next;
}

export function recordOutcome(storage: StorageLike, userId: string, day: string, item: TallyItem): Tally {
  const t = readTally(storage, userId, day);
  if (t.items.some((x) => x.opId === item.opId)) return t;
  return write(storage, userId, { day, items: [...t.items, item] });
}

/** «Отменить»: итог не состоялся, из сводки уходит. */
export function forgetOutcome(storage: StorageLike, userId: string, day: string, opId: string): Tally {
  const t = readTally(storage, userId, day);
  return write(storage, userId, { day, items: t.items.filter((x) => x.opId !== opId) });
}

/** Запись через мастер: отмечаем итог «Договорились» как записанный; нет такого итога на устройстве — добавляем. */
export function markBooked(storage: StorageLike, userId: string, day: string, opId: string, at: number): Tally {
  const t = readTally(storage, userId, day);
  const has = t.items.some((x) => x.opId === opId);
  const items = has ? t.items.map((x) => (x.opId === opId ? { ...x, booked: true } : x)) : [...t.items, { opId, kind: 'agreed' as const, at, booked: true }];
  return write(storage, userId, { day, items });
}

export function viewOf(t: Tally): TallyView {
  return {
    outcomes: t.items.length,
    connected: t.items.filter((x) => CONNECTED_KINDS.includes(x.kind)).length,
    booked: t.items.filter((x) => x.booked).length,
  };
}

/** Звонков за последний час. */
export function callsInLastHour(t: Tally, now: number): number {
  return t.items.filter((x) => x.at > now - 3_600_000 && x.at <= now).length;
}

/** Серверная сводка плюс итоги, ещё лежащие в outbox (на сервер они не дошли). */
export function withUnsent(server: TallyView, unsentKinds: readonly OutcomeKind[]): TallyView {
  return {
    outcomes: server.outcomes + unsentKinds.length,
    connected: server.connected + unsentKinds.filter((k) => CONNECTED_KINDS.includes(k)).length,
    booked: server.booked,
  };
}
