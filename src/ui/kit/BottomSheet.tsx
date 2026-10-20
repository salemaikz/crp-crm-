'use client';

import { Overlay, type OverlayProps } from './Overlay';

/**
 * Нижний лист: на телефоне выезжает снизу и достаёт до большого пальца (итог звонка, быстрые действия),
 * на широком экране — карточка по центру. Крупные кнопки внутри — size="lg", цель не меньше 44 px.
 */
export function BottomSheet(props: OverlayProps) {
  return <Overlay variant="sheet" {...props} />;
}
