'use client';

// «⋯ → Перенести в…»: список колонок-целей для плитки. Работает на телефоне пальцем и с клавиатуры; на ноутбуке
// это запасной путь рядом с перетаскиванием мышью (pipeline-v2 §9.2). Недоступные цели видны, но погашены, и причина
// названа по коду, а не общим «недоступно» (ui-polish §9.3, B8): запись — через звонок (с кнопкой «Позвонить»),
// покупку вносит консультант или РОП, прочее открывается в карточке клиента. Текст слева.
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BottomSheet, Button } from '@/ui/kit';
import type { MoveBlocked, MoveTarget } from './moves';
import type { BoardCardDto, BoardColumnConfig } from './types';

/** Причина недоступной цели словами: одна функция для списка и для тоста при отпускании плитки на запрещённую колонку. */
export function useBlockedText(outcomeLabel: string): (blocked: MoveBlocked) => string {
  const t = useTranslations('board');
  return (blocked) => t(`move.blocked.${blocked}`, { outcome: outcomeLabel });
}

export function MoveMenu({
  card,
  columns,
  titleOf,
  targets,
  outcomeLabel,
  canCall,
  cardHref,
  onPick,
  onCall,
  onClose,
}: {
  card: BoardCardDto;
  columns: readonly BoardColumnConfig[];
  titleOf: (c: BoardColumnConfig) => string;
  targets: readonly MoveTarget[];
  /** Подпись итога «Договорились» из настроек: в подсказке «запись — через звонок». */
  outcomeLabel: string;
  /** Позвонить можно (свои карточки, есть номер, не заблокировано): у цели «запись» появляется кнопка «Позвонить». */
  canCall: boolean;
  /** Ссылка на карточку клиента для целей, которые открываются там. */
  cardHref: string;
  onPick: (target: MoveTarget) => void;
  onCall: (card: BoardCardDto) => void;
  onClose: () => void;
}) {
  const t = useTranslations('board');
  const blockedText = useBlockedText(outcomeLabel);
  return (
    <BottomSheet open onClose={onClose} closeLabel={t('sheet.close')} title={t('move.title')} description={card.name}>
      <ul className="flex flex-col gap-2" data-testid="move-menu">
        {targets.map((tg) => {
          const col = columns.find((c) => c.key === tg.column);
          if (!col || tg.blocked === 'same') return null;
          if (tg.available) {
            return (
              <li key={tg.column}>
                <button type="button" className="k-btn k-btn--secondary k-btn--block justify-start text-left" onClick={() => onPick(tg)} data-testid={`move-to-${tg.column}`}>
                  {titleOf(col)}
                </button>
              </li>
            );
          }
          return (
            <li key={tg.column}>
              {/* Недоступная цель: название и причина слева, действие под причиной. aria-disabled только у названия:
                  у вложенной кнопки он сделал бы и её недоступной */}
              <div className="flex flex-col items-start gap-2 rounded-[var(--radius-control)] border p-3 text-left" style={{ borderColor: 'var(--border)', background: 'var(--canvas)' }} data-blocked={tg.blocked ?? undefined}>
                <div className="flex flex-col items-start gap-1" aria-disabled="true" data-testid={`move-to-${tg.column}`}>
                  <span className="font-semibold" style={{ color: 'var(--text-3)' }}>
                    {titleOf(col)}
                  </span>
                  {tg.blocked && (
                    <span className="text-sm" style={{ color: 'var(--text-2)' }} data-testid={`move-reason-${tg.column}`}>
                      {blockedText(tg.blocked)}
                    </span>
                  )}
                </div>
                {tg.blocked === 'book' && canCall && (
                  <Button variant="secondary" size="sm" onClick={() => onCall(card)} data-testid="move-call">
                    <Phone aria-hidden="true" />
                    {t('call.button')}
                  </Button>
                )}
                {tg.blocked === 'later' && (
                  <Button href={cardHref} variant="secondary" size="sm" data-testid="move-open-card">
                    {t('drawer.openCard')}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </BottomSheet>
  );
}
