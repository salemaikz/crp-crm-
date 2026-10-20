// Состояние тостов: чистый редьюсер без React и таймеров — его проверяют юнит-тесты.

export type ToastTone = 'neutral' | 'success' | 'danger' | 'info';

export type ToastInput = {
  /** Готовый текст из локали. */
  message: string;
  tone?: ToastTone;
  /** «Отменить»: окно отмены, пока тост виден. */
  undo?: { label: string; onUndo: () => void };
  /** Своё время показа, мс. */
  durationMs?: number;
};

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  undo?: { label: string; onUndo: () => void };
  durationMs: number;
};

export type ToastAction = { type: 'push'; toast: ToastItem } | { type: 'dismiss'; id: string } | { type: 'clear' };

/** Показ с «Отменить» длится 5 секунд (окно отмены итога, PROCESS 2.5), без него — 4. */
export const DEFAULT_DURATION_MS = 4000;
export const UNDO_DURATION_MS = 5000;
/** Видимых тостов не больше трёх: старые вытесняются. */
export const MAX_TOASTS = 3;

export function durationFor(input: Pick<ToastInput, 'undo' | 'durationMs'>): number {
  if (input.durationMs !== undefined && input.durationMs > 0) return input.durationMs;
  return input.undo ? UNDO_DURATION_MS : DEFAULT_DURATION_MS;
}

export function toastReducer(state: readonly ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.type) {
    case 'push':
      return [...state, action.toast].slice(-MAX_TOASTS);
    case 'dismiss':
      return state.filter((t) => t.id !== action.id);
    case 'clear':
      return [];
  }
}

let seq = 0;
export function makeToast(input: ToastInput): ToastItem {
  seq += 1;
  return {
    id: `toast-${seq}`,
    message: input.message,
    tone: input.tone ?? 'neutral',
    undo: input.undo,
    durationMs: durationFor(input),
  };
}
