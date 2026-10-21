'use client';

// «Переместить в…» (B8): список этапов воронки в нижнем листе; недоступные неактивны с причиной.
// Один и тот же путь для клавиатуры и телефона, где перетаскивания нет.
import { useTranslations } from 'next-intl';
import { BottomSheet } from '@/ui/kit';
import type { BoardStage } from './types';
import type { BlockReason, MoveDecision } from './moveRules';

type Props = {
  clientName: string;
  currentKey: string;
  stages: readonly BoardStage[];
  decide: (stageKey: string) => MoveDecision;
  onPick: (stageKey: string) => void;
  onClose: () => void;
};

export function MovePicker({ clientName, currentKey, stages, decide, onPick, onClose }: Props) {
  const t = useTranslations('deals.board');
  return (
    <BottomSheet open onClose={onClose} closeLabel={t('panel.close')} title={t('picker.title')} description={clientName}>
      <ul className="flex flex-col gap-2" data-testid="move-picker">
        {stages
          .filter((s) => s.key !== currentKey)
          .map((s) => {
            const d = decide(s.key);
            const blocked = d.kind === 'blocked' ? (d.reason satisfies BlockReason) : null;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  className="k-btn k-btn--secondary w-full text-left"
                  style={{ justifyContent: 'space-between' }}
                  disabled={blocked !== null || d.kind === 'noop'}
                  onClick={() => onPick(s.key)}
                  data-testid={`pick-${s.key}`}
                >
                  <span>{s.label}</span>
                  {blocked && (
                    <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                      {t(`blocked.${blocked}`)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
      </ul>
    </BottomSheet>
  );
}
