// Обзвон «подтвердить явку» на доске (D-355, pipeline-v2-round3 §1): чистые функции без React — строка шапки колонки,
// запросы трёх ответов, погашение без сети, соответствие ошибок сервера текстам. Названия и сроки приходят из настроек.
import type { BoardCardDto, BoardColumnConfig, BoardDto } from './types';

export type ConfirmInfo = NonNullable<BoardDto['confirm']>;
export type ConfirmMarkDto = NonNullable<BoardCardDto['confirm']>;

/** Плитка обзвона, которой ещё нужен ответ: «Подтвердить явку» и «Не дозвонился»; «Придёт» ответ уже получила. */
export const needsAnswer = (c: Pick<BoardCardDto, 'confirm'>): boolean => c.confirm !== undefined && c.confirm.mark !== 'confirmed';

/** Мероприятия обзвона, относящиеся к колонке по видам записи; у колонки без видов — все. */
export function confirmEventsFor(confirm: ConfirmInfo, eventTypes: readonly string[]): ConfirmInfo['events'] {
  return eventTypes.length === 0 ? confirm.events : confirm.events.filter((e) => eventTypes.includes(e.type));
}

/** Колонка записи, куда включение фильтра «Подтвердить явку» открывает вкладку: первая «Договорились» с видом из обзвона. */
export function confirmColumnKey(columns: readonly Pick<BoardColumnConfig, 'key' | 'role' | 'eventTypes'>[], confirm: ConfirmInfo): string | null {
  const agreed = columns.filter((c) => c.role === 'agreed');
  return (agreed.find((c) => confirmEventsFor(confirm, c.eventTypes).length > 0 && c.eventTypes.length > 0) ?? agreed.find((c) => confirmEventsFor(confirm, c.eventTypes).length > 0) ?? null)?.key ?? null;
}

/** Осталось ответить: ещё не звонили и не дозвонились. */
export const remainingOf = (s: ConfirmInfo['summary']): number => s.todo + s.tried;

/** «2026-10-24» → «24.10» без часовых поясов: местная дата мероприятия уже в строке. */
export function dayMonth(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[2]}.${m[1]}` : date;
}

/** «БР 24.10; БК 25.10» для строки шапки: короткие подписи видов из настроек. */
export function eventsText(events: ConfirmInfo['events'], labels: Readonly<Record<string, string>>, unknown: string): string {
  return events.map((e) => `${labels[e.type] ?? unknown} ${dayMonth(e.date)}`).join('; ');
}

// ---------- Запросы ответов ----------

export interface ConfirmRequest {
  url: string;
  body: Record<string, unknown>;
}

/** «Придёт»: подтверждение записи. Версия — версия записи с плитки. Нет записи на плитке — null. */
export function yesRequest(card: Pick<BoardCardDto, 'event'>, opId: string): ConfirmRequest | null {
  if (!card.event) return null;
  return { url: `/api/bookings/${encodeURIComponent(card.event.bookingId)}/confirm`, body: { opId, version: card.event.bookingVersion, to: 'confirmed' } };
}

/** «Не придёт»: выход № 33 в «Перезвон» с причиной из настроек и сроком «в течение дня». */
export function declineRequest(card: Pick<BoardCardDto, 'id' | 'version'>, declineReason: string, callbackAt: number, opId: string): ConfirmRequest {
  return { url: `/api/cards/${encodeURIComponent(card.id)}/move`, body: { opId, version: card.version, to: 'callback', reasonCode: declineReason, callbackAt, callbackPrecision: 'day' } };
}

// ---------- Офлайн и ошибки ----------

/** Без сети «Придёт» и «Не придёт» гасятся (правка записи с версией не должна применяться вслепую), «Не дозвонился» идёт через очередь. */
export const offlineDisabled = (online: boolean): { yes: boolean; decline: boolean; noAnswer: boolean } => ({ yes: !online, decline: !online, noAnswer: false });

export type ConfirmErrorKey = 'changed' | 'tooLate' | 'notApplicable' | 'unavailable' | 'readOnly' | 'failed';

/** Ответ сервера → текст тоста: 409 — запись изменилась; 400 `too_late`, `reason_not_applicable`; 404; 423. */
export function errorKeyOf(status: number, code: string | null): ConfirmErrorKey {
  if (status === 409) return 'changed';
  if (status === 404) return 'unavailable';
  if (status === 423) return 'readOnly';
  if (status === 400 && code === 'too_late') return 'tooLate';
  if (status === 400 && code === 'reason_not_applicable') return 'notApplicable';
  return 'failed';
}

/** После этих ответов повтор того же действия бессмыслен: opId сбрасывается, доска перечитывается. */
export const settles = (status: number): boolean => status !== 0 && status < 500;

/** Повтор после сетевой ошибки использует тот же opId: он хранится по действию, пока ответ не получен. */
export class OpIds {
  private readonly ids = new Map<string, string>();
  constructor(private readonly make: () => string) {}
  /** opId действия: один на (карточка, действие) до `done`. */
  get(cardId: string, action: string): string {
    const key = `${cardId}:${action}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.make();
      this.ids.set(key, id);
    }
    return id;
  }
  done(cardId: string, action: string): void {
    this.ids.delete(`${cardId}:${action}`);
  }
}
