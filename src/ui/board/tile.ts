// Что показывает плитка лида (pipeline-v2 §9.3, §5.3): чистые функции без React, чтобы раскладку проверяли юнит-тесты.
import { fieldText } from '@/ui/call/fieldText';
import type { OutcomeButton } from '@/ui/call/types';
import { attendControls, attendedOf, type AttendControl, type AttendKind } from './attend';
import { isEndRole, isWorkingRole } from './columns';
import type { BoardCardDto, BoardConfig, BoardReason, ColumnRole } from './types';

export type Tone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';
const TONES: readonly Tone[] = ['success', 'warning', 'info', 'danger', 'neutral'];

/**
 * Тон плитки по `board.tones` (§5.3): первое совпавшее условие. Неизвестное имя тона или условие пропускаются, чтобы
 * ошибка пресета не ломала экран. Покупка считается только если сервер прислал признак (`purchases` есть). Явка берётся
 * из `attendedOf` — той же функции, что у значка и тумблера (ui-polish §9.4).
 */
export function toneOf(card: BoardCardDto, tones: readonly { when: string; tone: string }[], behaviors: BoardConfig['eventBehaviors'] = {}): Tone | null {
  for (const t of tones) {
    if (!(TONES as readonly string[]).includes(t.tone)) continue;
    const hit =
      t.when === 'attendedIndividual' ? attendedOf(card, 'attendedIndividual', behaviors)
      : t.when === 'attendedGroup' ? attendedOf(card, 'attendedGroup', behaviors)
      : t.when === 'noShow' ? card.flags.noShow
      : t.when === 'purchased' ? (card.purchases?.total ?? 0) > 0
      : false;
    if (hit) return t.tone as Tone;
  }
  return null;
}

export type BadgeId = 'attended' | 'purchased' | 'noShow';

export interface TileBadge {
  id: BadgeId;
  /** Для «Был: …» — виды, на которых был клиент. */
  kinds: AttendKind[];
}

/**
 * Один значок признаков плитки (ui-polish §9.3): «✓ Был: {вид записи} · {вид записи}», иначе «Не пришёл», иначе «Покупал».
 * «Не пришёл» не выводится, если чип уже говорит системной причиной неявки (`noShowReasons` — коды из настроек).
 * Явка у того, кто вправе её отмечать, живёт переключателем (`controls`), и значка «Был» тогда нет.
 */
export function tileBadge(card: BoardCardDto, controls: readonly AttendControl[], noShowReasons: readonly string[]): TileBadge | null {
  const kinds = controls.filter((c) => c.mode === 'badge').map((c) => c.kind);
  if (kinds.length > 0) return { id: 'attended', kinds };
  const noShowChip = card.state === 'callback' && noShowReasons.includes(card.callbackReason);
  if (card.flags.noShow && !noShowChip) return { id: 'noShow', kinds: [] };
  if (card.purchases !== undefined && card.purchases.total > 0) return { id: 'purchased', kinds: [] };
  return null;
}

export type ChipView =
  | { kind: 'reason'; reason: string; touches: number }
  | { kind: 'attempts'; n: number }
  | { kind: 'event'; type: string; status: string; startsAt: number }
  | { kind: 'state'; state: string }
  | { kind: 'none' };

/** Чип под названием: причина перезвона и касание, недозвон, запись или просто состояние. */
export function chipOf(card: BoardCardDto): ChipView {
  if (card.state === 'agreed' && card.event) return { kind: 'event', type: card.event.type, status: card.event.status, startsAt: card.event.startsAt };
  if (card.state === 'callback' && card.callbackReason !== '') return { kind: 'reason', reason: card.callbackReason, touches: card.callbackTouches };
  if (card.state === 'retry' && card.attempts > 0) return { kind: 'attempts', n: card.attempts };
  if (card.state === 'callback') return { kind: 'state', state: 'callback' };
  if (card.state === 'new') return { kind: 'none' };
  return { kind: 'state', state: card.state };
}

/** Подпись причины перезвона из справочника; кода нет в справочнике (старый или служебный) — null, сырой ключ не показываем. */
export function reasonLabel(labels: Readonly<Record<string, string>>, code: string): string | null {
  const v = Object.hasOwn(labels, code) ? labels[code] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export type DueView =
  | { kind: 'none' }
  | { kind: 'overdue'; precision: 'time' | 'day'; at: number; minutes: number }
  | { kind: 'today'; precision: 'time' | 'day'; at: number }
  | { kind: 'later'; precision: 'time' | 'day'; at: number };

/** Срок перезвона: просрочка и «сегодня» берутся от сервера (`fire`, одно правило, §4.3), здесь только форма показа. */
export function dueOf(card: BoardCardDto, now: number): DueView {
  if (card.nextCallAt === null) return { kind: 'none' };
  const precision = card.nextCallPrecision;
  if (card.fire === 'overdue') return { kind: 'overdue', precision, at: card.nextCallAt, minutes: Math.max(1, Math.round((now - card.nextCallAt) / 60_000)) };
  if (card.fire === 'today') return { kind: 'today', precision, at: card.nextCallAt };
  return { kind: 'later', precision, at: card.nextCallAt };
}

/** Огонёк: перезвон на сегодня или просрочен. */
export const hasFire = (card: BoardCardDto): boolean => card.fire === 'today' || card.fire === 'overdue';

/** Просрочка словами: «2 ч» / «35 мин» / «3 д». */
export function overdueParts(minutes: number): { unit: 'min' | 'hour' | 'day'; n: number } {
  if (minutes < 60) return { unit: 'min', n: minutes };
  if (minutes < 60 * 24) return { unit: 'hour', n: Math.round(minutes / 60) };
  return { unit: 'day', n: Math.round(minutes / (60 * 24)) };
}

// ---------- Раскладка плитки: строки (ui-polish §9.3) ----------

export type TileLayout = 'phone' | 'laptop';

export interface TileCtx {
  role: ColumnRole;
  scope: BoardConfig['scope'];
  /** Звонок с плитки разрешён зрителю (свои карточки, право на итог). */
  canCall: boolean;
  config: Pick<BoardConfig, 'canAttend' | 'eventBehaviors' | 'agreedExit'>;
  now: number;
  /** Поля `showOn.kanban` для строки «Новых». */
  tileFields: readonly TileField[];
  /** Подписи причин закрытия для конечной колонки «Мусор». */
  closeLabel: (card: BoardCardDto) => string;
}

/** Поле плитки (`showOn.kanban`): подпись значения берётся из вариантов поля. */
export interface TileField {
  key: string;
  label: string;
  options: Record<string, string>;
}

/** Значения полей плитки для «Новых»: не больше двух непустых, в порядке настроек. */
export function tileValues(card: BoardCardDto, fields: readonly TileField[], limit = 2): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (!Object.hasOwn(card.values, f.key)) continue;
    const text = fieldText(card.values[f.key], f.options).trim();
    if (text !== '') out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

export interface TileRows {
  /** Строка 2: чип и срок, значения полей «Новых», либо «сумма · дата» / «причина · дата» конечной колонки. */
  meta: boolean;
  /** Строка 3: ЛПР или ответственный, закрытый номер, явка. */
  contact: boolean;
  /** Строка 4 (только телефон): «Позвонить» и WhatsApp. */
  actions: boolean;
  /** Всего строк плитки, считая название. */
  count: number;
}

/**
 * Какие строки есть у плитки. Строка, которой нечего показать, не выводится (пустой заглушки нет). Не больше четырёх
 * строк на телефоне и трёх на ноутбуке, где «Позвонить» уходит в первую строку (PROCESS 4.4).
 */
export function tileRows(card: BoardCardDto, ctx: TileCtx, layout: TileLayout): TileRows {
  const end = isEndRole(ctx.role);
  const chip = chipOf(card);
  const due = dueOf(card, ctx.now);
  const controls = attendControls(card, ctx.config, ctx.now);
  const badge = tileBadge(card, controls, Object.values(ctx.config.agreedExit.noShowReasons));
  const hasPhone = card.phone !== null;
  const own = ctx.scope === 'own' && ctx.canCall;
  let meta: boolean;
  if (end) {
    meta = ctx.role === 'client' ? card.purchases !== undefined && (card.purchases.lastAt !== null || card.purchases.lastAmountKzt !== null) : card.closedAt !== null || ctx.closeLabel(card) !== '';
  } else {
    meta = chip.kind !== 'none' || due.kind !== 'none' || (ctx.role === 'new' && tileValues(card, ctx.tileFields).length > 0);
  }
  const contact = !end && ((ctx.scope === 'own' && card.lprName !== '') || hasPhone || controls.length > 0 || badge !== null || (own && !hasPhone));
  // «Позвонить» в «Договорились» — только у плиток обзвона, которым нужен ответ (D-355)
  const asksConfirm = ctx.role === 'agreed' && card.confirm !== undefined && card.confirm.mark !== 'confirmed';
  const actions = !end && (isWorkingRole(ctx.role) || asksConfirm) && layout === 'phone' && own && hasPhone;
  return { meta, contact, actions, count: 1 + (meta ? 1 : 0) + (contact ? 1 : 0) + (actions ? 1 : 0) };
}

/** Подпись причины закрытия: вид итога карточки (`state`) → причина из настроек; нет подписи — пусто (сырой код не показываем). */
export function closeReasonLabel(card: BoardCardDto, outcomes: readonly OutcomeButton[], writeOff: readonly BoardReason[]): string {
  if (card.closeReasonCode === '') return '';
  if (card.state === 'written_off') return writeOff.find((r) => r.key === card.closeReasonCode)?.label ?? '';
  return outcomes.find((o) => o.kind === card.state)?.reasons.find((r) => r.key === card.closeReasonCode)?.label ?? '';
}

/** Ключ слова статуса записи на плитке: «Не подтвердил» молчит (по умолчанию все записи такие), D-358 п. 7. */
export function eventStatusKey(status: string): 'confirmed' | 'no_show' | null {
  return status === 'confirmed' || status === 'no_show' ? status : null;
}

/** Где стоит «·» между ЛПР и номером: в конце блока ЛПР (никогда не в начале строки); иначе его нет. */
export function contactDot(p: { hasName: boolean; hasPhone: boolean }): 'after-name' | 'none' {
  return p.hasName && p.hasPhone ? 'after-name' : 'none';
}
