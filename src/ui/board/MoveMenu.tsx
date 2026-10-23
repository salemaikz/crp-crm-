'use client';

// «⋯ → Перенести в…»: список колонок-целей для плитки. Работает на телефоне пальцем и с клавиатуры; на ноутбуке
// это запасной путь рядом с перетаскиванием мышью (pipeline-v2 §9.2). Недоступные цели видны, но погашены, с причиной.
import { useTranslations } from 'next-intl';
import { BottomSheet } from '@/ui/kit';
import type { MoveTarget } from './moves';
import type { BoardCardDto, BoardColumnConfig } from './types';

export function MoveMenu({
  card,
  columns,
  titleOf,
  targets,
  onPick,
  onClose,
}: {
  card: BoardCardDto;
  columns: readonly BoardColumnConfig[];
  titleOf: (c: BoardColumnConfig) => string;
  targets: readonly MoveTarget[];
  onPick: (target: MoveTarget) => void;
  onClose: () => void;
}) {
  const t = useTranslations('board');
  return (
    <BottomSheet open onClose={onClose} closeLabel={t('sheet.close')} title={t('move.title')} description={card.name}>
      <ul className="flex flex-col gap-2" data-testid="move-menu">
        {targets.map((tg) => {
          const col = columns.find((c) => c.key === tg.column);
          if (!col || tg.blocked === 'same') return null;
          return (
            <li key={tg.column}>
              <button
                type="button"
                className="k-btn k-btn--secondary k-btn--block text-left"
                disabled={!tg.available}
                onClick={() => onPick(tg)}
                data-testid={`move-to-${tg.column}`}
              >
                <span className="flex flex-col items-start">
                  <span>{titleOf(col)}</span>
                  {tg.blocked && (
                    <span className="text-xs font-normal" style={{ color: 'var(--text-3)' }}>
                      {t(`move.blocked.${tg.blocked}`)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </BottomSheet>
  );
}
