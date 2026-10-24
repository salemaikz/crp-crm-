// Шапка карточки и доска (воронка v2, §9.4): колонка по правилу ядра, подпись причины перезвона, явка и тон.
// Чистая часть (`toCardBoard`) не читает БД и время; настройки приходят параметром (`loadBoardHead`).
import { calling } from '@crm/core';
import type { Viewer } from '@/server/access';
import { parseBoardSettings, type BoardSettings } from '@/server/domain/cards/boardSettings';
import { getActiveConfig } from '@/server/platform/config/active';
import { isFeatureEnabled } from '@/server/platform/flags';
import type { CardHeadDb } from './repo';
import type { CardBoardDto, CardTone } from './types';

const TONES: readonly CardTone[] = ['success', 'warning', 'info', 'danger', 'neutral'];

export type BoardHeadSettings = {
  board: BoardSettings;
  /** Причины перезвона: ключ → подпись (все, включая архивные и системные). */
  callbackReasons: Record<string, string>;
  /** Короткая подпись вида мероприятия по поведению `group` / `individual`. */
  attendLabels: { group: string | null; individual: string | null };
};

/** Настройки доски для шапки или `null`, если доска выключена (`OP_BOARD`) или у зрителя нет пространства. */
export async function loadBoardHead(viewer: Viewer): Promise<BoardHeadSettings | null> {
  if (!isFeatureEnabled('OP_BOARD') || viewer.spaceId === null) return null;
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  if (!space) return null;
  const doc = space.doc as unknown as {
    reasons?: Record<string, Array<{ key: string; label?: { ru?: string } }> | undefined>;
    booking?: { eventTypes?: Array<{ behavior?: string; label?: { ru?: string }; short?: { ru?: string } }> };
  };
  const callbackReasons: Record<string, string> = {};
  for (const r of doc.reasons?.callback ?? []) if (r.label?.ru) callbackReasons[r.key] = r.label.ru;
  const attend = (behavior: string): string | null => {
    const e = doc.booking?.eventTypes?.find((x) => x.behavior === behavior);
    return e ? (e.short?.ru ?? e.label?.ru ?? null) : null;
  };
  return { board: parseBoardSettings(space.doc), callbackReasons, attendLabels: { group: attend('group'), individual: attend('individual') } };
}

type BoardRow = Pick<
  CardHeadDb,
  | 'state'
  | 'holdReason'
  | 'ownerUserId'
  | 'attempts'
  | 'closedAt'
  | 'bookingType'
  | 'bookingStatus'
  | 'callbackReason'
  | 'callbackTouches'
  | 'nextCallPrecision'
  | 'attendedGroupAt'
  | 'attendedIndividualAt'
  | 'lastNoShowAt'
  | 'purchasesTotal'
>;

/** Поля шапки от доски. `canSeePurchases` — у зрителя есть `deal.read`: без него «покупал» не раскрывается. */
export function toCardBoard(r: BoardRow, s: BoardHeadSettings, canSeePurchases: boolean): CardBoardDto {
  const booking = r.bookingType !== null && r.bookingStatus !== null ? { eventType: r.bookingType, status: r.bookingStatus, dealIsOpen: true } : null;
  const column = calling.columnOf(
    { state: r.state as calling.CardState, holdReason: r.holdReason as calling.CardSnapshot['holdReason'], ownerUserId: r.ownerUserId, attempts: r.attempts, closedAt: r.closedAt },
    booking,
    s.board.spec,
  );
  const attendedGroup = r.attendedGroupAt !== null;
  const attendedIndividual = r.attendedIndividualAt !== null;
  const lastAttended = Math.max(r.attendedGroupAt ?? 0, r.attendedIndividualAt ?? 0);
  const noShow = r.lastNoShowAt !== null && r.lastNoShowAt > lastAttended;
  const purchased = canSeePurchases && r.purchasesTotal > 0;
  const hits: Record<string, boolean> = { attendedIndividual, attendedGroup, noShow, purchased };
  const tone = s.board.tones.find((t) => (TONES as readonly string[]).includes(t.tone) && hits[t.when] === true)?.tone ?? null;
  const reason = Object.hasOwn(s.callbackReasons, r.callbackReason) ? s.callbackReasons[r.callbackReason] : undefined;
  return {
    column,
    columnLabel: s.board.columns.find((c) => c.key === column)?.label ?? null,
    tone: tone as CardTone | null,
    callbackReason: r.callbackReason,
    callbackReasonLabel: reason && reason.trim() !== '' ? reason : null,
    callbackTouches: r.callbackTouches,
    attended: { group: attendedGroup ? (s.attendLabels.group ?? '') : null, individual: attendedIndividual ? (s.attendLabels.individual ?? '') : null },
    noShow,
    purchased,
  };
}
