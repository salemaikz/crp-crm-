// Тумблеры «Был на …» на плитке и в шторке (pipeline-v2 §5.2) и явка в окне № 33 (§3.4): чистые функции без React.
// Тумблер показывает признак карточки. У того, кто вправе отмечать явку (`booking.attend` у роли), нажатие — отметка
// «пришёл» по записи этого вида открытой сделки. У оператора по умолчанию права нет (D-340, ВП-4): тумблер только показывает.
// Разрешить оператору отметку можно одной правкой пресета (право роли), код менять не нужно.
import type { BoardCardDto, BoardConfig } from './types';

export type AttendKind = 'attendedGroup' | 'attendedIndividual';
export const ATTEND_KINDS: readonly AttendKind[] = ['attendedGroup', 'attendedIndividual'];

/** Статусы записи, из которых отметка «пришёл» допустима автоматом статусов (registered, confirmed, no_show). */
const MARKABLE = ['registered', 'confirmed', 'no_show'];

/** Почему тумблер нельзя нажать (подсказка из локали `board.toggle.hint.*`). */
export type ToggleHint = 'noRight' | 'noBooking' | 'notStarted' | 'done' | 'lastStatus';

export interface ToggleView {
  kind: AttendKind;
  /** Признак карточки: был на мероприятии этого вида. */
  on: boolean;
  /** Нажатие отмечает явку по записи карточки. */
  interactive: boolean;
  hint: ToggleHint | null;
}

/** Вид записи карточки в терминах тумблеров: по `behavior` вида записи; неизвестный вид — null. */
export function eventKindOf(card: BoardCardDto, behaviors: BoardConfig['eventBehaviors']): AttendKind | null {
  if (!card.event) return null;
  const b = behaviors[card.event.type];
  return b === 'group' ? 'attendedGroup' : b === 'individual' ? 'attendedIndividual' : null;
}

/**
 * Состояние тумблера `kind`. Нажать можно, если есть право, у карточки открытая запись этого вида, мероприятие
 * началось и запись не отмечена «пришёл». Прочее — погашено с подсказкой.
 */
export function toggleView(card: BoardCardDto, kind: AttendKind, config: Pick<BoardConfig, 'canAttend' | 'eventBehaviors'>, now: number): ToggleView {
  const on = card.flags[kind];
  const ev = card.event;
  const evKind = eventKindOf(card, config.eventBehaviors);
  if (!ev || evKind !== kind) return { kind, on, interactive: false, hint: 'noBooking' };
  if (ev.status === 'attended') return { kind, on: true, interactive: false, hint: 'done' };
  if (!config.canAttend) return { kind, on, interactive: false, hint: 'noRight' };
  if (ev.startsAt > now) return { kind, on, interactive: false, hint: 'notStarted' };
  if (!MARKABLE.includes(ev.status)) return { kind, on, interactive: false, hint: 'lastStatus' };
  return { kind, on, interactive: true, hint: null };
}

/**
 * Тумблеры плитки: только те, что что-то значат (признак есть или запись этого вида) — плитка не больше четырёх строк.
 * `all` (шторка лида) показывает оба, в том числе погашенные с подсказкой «нет записи».
 */
export function toggleViews(card: BoardCardDto, config: Pick<BoardConfig, 'canAttend' | 'eventBehaviors'>, now: number, all = false): ToggleView[] {
  const evKind = eventKindOf(card, config.eventBehaviors);
  return ATTEND_KINDS.filter((k) => all || card.flags[k] || evKind === k).map((k) => toggleView(card, k, config, now));
}

/** Запрос отметки явки (`POST /api/bookings/[id]/attendance`); `null`, если у плитки нет записи. */
export function attendanceRequest(card: BoardCardDto, to: 'attended' | 'no_show', opId: string): { url: string; body: { opId: string; version: number; to: 'attended' | 'no_show' } } | null {
  if (!card.event) return null;
  return { url: `/api/bookings/${encodeURIComponent(card.event.bookingId)}/attendance`, body: { opId, version: card.event.bookingVersion, to } };
}

// ---------- Явка в окне № 33 ----------

export type ExitAttendance = 'attended' | 'no_show' | 'none';

export interface AttendanceBlock {
  /** `switch` — оператор отмечает; `readonly` — только статус; `hidden` — записи нет. */
  mode: 'switch' | 'readonly' | 'hidden';
  /** Статус записи сейчас: `unmarked` — не отмечена. */
  status: 'attended' | 'no_show' | 'unmarked';
  bookingId: string | null;
  /** Почему нельзя отметить (для подсказки только для чтения). */
  hint: 'noRight' | 'notStarted' | null;
}

/** Блок явки окна № 33: переключатель виден, если мероприятие началось, есть право и явка не отмечена; иначе статус только для чтения. */
export function attendanceBlock(card: BoardCardDto, canAttend: boolean, now: number): AttendanceBlock {
  const ev = card.event;
  if (!ev) return { mode: 'hidden', status: 'unmarked', bookingId: null, hint: null };
  const status = ev.status === 'attended' ? 'attended' : ev.status === 'no_show' ? 'no_show' : 'unmarked';
  if (!canAttend) return { mode: 'readonly', status, bookingId: ev.bookingId, hint: 'noRight' };
  if (ev.startsAt > now) return { mode: 'readonly', status, bookingId: ev.bookingId, hint: 'notStarted' };
  // Явка уже отмечена: переключателя нет, перенос не шлёт attendance (иначе 409 attendance_changed, §3.3)
  if (status !== 'unmarked') return { mode: 'readonly', status, bookingId: ev.bookingId, hint: null };
  return { mode: 'switch', status, bookingId: ev.bookingId, hint: null };
}
