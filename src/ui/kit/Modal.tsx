'use client';

import { Overlay, type OverlayProps } from './Overlay';

/** Диалог по центру: для подтверждения и коротких форм. Поверх него другой диалог или лист не открывается. */
export function Modal(props: OverlayProps) {
  return <Overlay variant="modal" {...props} />;
}
