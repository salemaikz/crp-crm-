'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { cn } from './cn';
import { makeToast, toastReducer, type ToastInput, type ToastItem, type ToastTone } from './toastState';

type ToastApi = {
  /** Показать тост; возвращает id для ручного закрытия. */
  show: (input: ToastInput) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast: оберните приложение в <ToastProvider>');
  return api;
}

const ICONS: Record<ToastTone, typeof Info | null> = { neutral: null, success: CircleCheck, danger: CircleAlert, info: Info };

/** Один тост. Таймер стоит, пока на нём курсор или фокус (WCAG 2.2.1): успеть нажать «Отменить». */
function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const { id, durationMs } = toast;
  useEffect(() => {
    if (paused) return;
    const h = setTimeout(() => onDismiss(id), durationMs);
    return () => clearTimeout(h);
  }, [paused, id, durationMs, onDismiss]);

  const Icon = ICONS[toast.tone];
  return (
    <div
      className={cn('k-toast', `k-toast--${toast.tone}`)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {Icon && <Icon aria-hidden="true" />}
      <span className="k-toast__message">{toast.message}</span>
      {toast.undo && (
        <button
          type="button"
          className="k-toast__undo"
          onClick={() => {
            toast.undo?.onUndo();
            onDismiss(id);
          }}
        >
          {toast.undo.label}
        </button>
      )}
    </div>
  );
}

/** Провайдер тостов и их область (aria-live). Кладётся один раз в оболочку. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const dismiss = useCallback((id: string) => dispatch({ type: 'dismiss', id }), []);
  const show = useCallback((input: ToastInput) => {
    const toast = makeToast(input);
    dispatch({ type: 'push', toast });
    return toast.id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="k-toasts" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
