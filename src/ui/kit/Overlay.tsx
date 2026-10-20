'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { acquireLayer, releaseLayer } from './overlay';
import { cn } from './cn';

export type OverlayProps = {
  open: boolean;
  onClose: () => void;
  /** Заголовок обязателен: он же имя диалога для скринридера. */
  title: ReactNode;
  /** Подпись кнопки «закрыть» из локали. */
  closeLabel: string;
  description?: ReactNode;
  /** Нижняя панель действий (одна главная кнопка + при необходимости вторичные). */
  footer?: ReactNode;
  /** false — закрыть можно только кнопками внутри (Esc и фон не закрывают). */
  dismissible?: boolean;
  className?: string;
  children?: ReactNode;
};

type Variant = 'modal' | 'sheet';

/**
 * Общая основа Modal и BottomSheet на нативном <dialog>: фокус-ловушка, Esc, инертный фон, возврат
 * фокуса — от браузера. Состояние держит родитель (open/onClose); слой — один на всё приложение.
 */
export function Overlay({
  variant,
  open,
  onClose,
  title,
  closeLabel,
  description,
  footer,
  dismissible = true,
  className,
  children,
}: OverlayProps & { variant: Variant }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    if (!acquireLayer(id)) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Overlay: второй слой модалок не открывается (правило UX: не больше одного).');
      }
      onCloseRef.current();
      return;
    }
    if (!dialog.open) dialog.showModal();
    return () => {
      releaseLayer(id);
      if (dialog.open) dialog.close();
    };
  }, [open, id]);

  return (
    <dialog
      ref={ref}
      className={cn('k-overlay', `k-overlay--${variant}`, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="k-overlay__panel">
          {variant === 'sheet' && <span className="k-overlay__handle" aria-hidden="true" />}
          <div className="k-overlay__head">
            <h2 id={titleId} className="k-overlay__title">
              {title}
            </h2>
            <button type="button" className="k-btn k-btn--quiet k-btn--icon" aria-label={closeLabel} onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </div>
          {description && (
            <p id={descId} className="k-overlay__desc">
              {description}
            </p>
          )}
          <div className="k-overlay__body">{children}</div>
          {footer && <div className="k-overlay__footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
