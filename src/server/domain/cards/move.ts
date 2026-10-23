// № 33. Выход из «Договорились» без звонка (pipeline-v2 §3.3, D-336): одна транзакция —
// блокировка карточки с охватом → версия и `opId` → явка по записи через порт записи (без события карточки) →
// ядро `calling.applyOutcome` (`agreed_exit`) → эффекты и пересчёт кэша (persistTransition). Правил состояния здесь нет.
// Сбой на любом шаге откатывает всё, включая отметку явки.
import { booking as coreBooking, type calling } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { bookingPort } from '@/server/domain/booking';
import { isRetryableTxError, MAX_TX_ATTEMPTS } from '@/server/domain/booking/tx';
import { insertNote } from '@/server/domain/timeline/repo';
import { getActiveConfig } from '@/server/platform/config/active';
import { getDb, newId } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import { CardActionError } from './errors';
import { applyCardEventLocked } from './manual';
import { findMoveOpState, listFutureActiveBookingIds, lockCardScoped } from './repo';
import { loadCallingContext } from './settings';
import type { MenuResult } from './menu';

export type MoveTarget = 'callback' | 'not_interested' | 'written_off';

export interface MoveInput {
  opId: string;
  version: number;
  to: MoveTarget;
  reasonCode: string;
  reasonText?: string | undefined;
  callbackAt?: number | undefined;
  callbackPrecision?: calling.CallbackPrecision | undefined;
  attendance?: { bookingId: string; to: 'attended' | 'no_show' } | undefined;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Требует ли причина текста (`needsText` справочника группы `to`); нет в справочнике — не требует. */
async function reasonNeedsText(viewer: Viewer, group: MoveTarget, code: string): Promise<boolean> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  const list = (space?.doc?.reasons as Record<string, Array<{ key: string; needsText?: boolean }> | undefined> | undefined)?.[group] ?? [];
  return list.find((r) => r.key === code)?.needsText === true;
}

/**
 * № 33. Повтор с тем же `opId` возвращает прежний результат (состояние — из ленты, версия — текущая) и ничего
 * не меняет. Чужая карточка и запись не открытой сделки этой карточки — 404 тем же телом.
 */
export async function moveCard(viewer: Viewer, cardId: string, input: MoveInput): Promise<MenuResult> {
  if (!isFeatureEnabled('OP_BOARD') || viewer.spaceId === null) throw new NotFoundError();
  const text = input.reasonText?.trim() ?? '';
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx(async (tx): Promise<MenuResult> => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        const now = Date.now();
        const row = await lockCardScoped(tx, viewer, cardId, 'card.outcome');
        if (!row || row.spaceId !== viewer.spaceId) throw new NotFoundError();
        const snap = row.snapshot;

        const done = await findMoveOpState(tx, { clientId: snap.clientId, opId: input.opId });
        if (done !== null) return { version: snap.version, state: done };

        // Версию проверяем до отметки явки: чужая правка не должна оставлять явку без перехода
        if (snap.version !== input.version) throw new CardActionError('version_conflict', null, snap.version);
        if (snap.state !== 'agreed') throw new CardActionError('invalid_transition', null, snap.version);
        if (text === '' && input.reasonCode !== '' && (await reasonNeedsText(viewer, input.to, input.reasonCode))) {
          throw new CardActionError('reason_required', 'reasonText', snap.version);
        }

        let attendance: calling.AgreedExitEvent['attendance'] = null;
        if (input.attendance) {
          const r = await bookingPort.setAttendanceInTx(tx, viewer, { bookingId: input.attendance.bookingId, to: input.attendance.to, opId: input.opId, cardId });
          attendance = { bookingId: input.attendance.bookingId, to: input.attendance.to, eventKind: r.eventKind, changed: r.changed };
        }
        const futureBookingIds = attendance
          ? []
          : await listFutureActiveBookingIds(tx, { spaceId: row.spaceId, clientId: snap.clientId, after: now, statuses: coreBooking.ACTIVE_STATUSES });

        const ctx = await loadCallingContext(row.spaceId, now);
        const result = await applyCardEventLocked(
          tx,
          viewer,
          row,
          ctx,
          {
            type: 'agreed_exit',
            opId: input.opId,
            seenVersion: input.version,
            to: input.to,
            reasonCode: input.reasonCode,
            callbackAt: input.to === 'callback' ? (input.callbackAt ?? null) : null,
            ...(input.callbackPrecision ? { callbackPrecision: input.callbackPrecision } : {}),
            attendance,
            facts: { futureBookingIds },
          },
          now,
          { opId: input.opId },
        );
        if (result.status === 'rejected') throw new CardActionError(result.error, result.field, snap.version);
        if (result.status !== 'applied') throw new CardActionError('invalid_transition', null, snap.version);
        if (text !== '') await insertNote(tx, viewer, { id: newId(), clientId: snap.clientId, dealId: null, body: text });
        return { version: result.card.version, state: result.card.state };
      });
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}
