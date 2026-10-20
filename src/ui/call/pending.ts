// «Намерение звонка» и черновик шторки в localStorage: переживают выгрузку приложения, пока оператор в звонилке.
// Хранится только название компании и закрытый номер (`+7 709 ••• •• 67`); цифры номеров на устройство не пишутся.
import type { StorageLike } from './tally';
import { EMPTY_DRAFT, type PendingCall, type SheetDraft } from './types';

export interface PendingState {
  call: PendingCall;
  draft: SheetDraft;
}

const key = (userId: string) => `crm.call.pending.${userId}`;

export function readPending(storage: StorageLike, userId: string): PendingState | null {
  try {
    const raw = storage.getItem(key(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as PendingState;
    if (!v?.call || typeof v.call.opId !== 'string' || typeof v.call.cardId !== 'string') return null;
    return { call: v.call, draft: { ...EMPTY_DRAFT, ...(v.draft ?? {}) } };
  } catch {
    return null;
  }
}

export function writePending(storage: StorageLike, userId: string, state: PendingState): void {
  try {
    storage.setItem(key(userId), JSON.stringify(state));
  } catch {
    // нет места: шторка откроется без восстановления
  }
}

export function clearPending(storage: StorageLike, userId: string): void {
  try {
    storage.removeItem(key(userId));
  } catch {
    // не критично
  }
}
