'use client';

// Над доской: поиск по своим клиентам, сортировка и чипы-фильтры (pipeline-v2 §9.4), «Звонить подряд» в шапке.
import { Phone, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Chip, ChipGroup, Input, Segmented } from '@/ui/kit';
import { availableFilters } from './order';
import { BOARD_SORTS, type BoardFilter, type BoardSort } from './types';

export function BoardControls({
  q,
  onQ,
  sort,
  onSort,
  filters,
  onToggleFilter,
  canPurchases,
  attendLabels,
}: {
  q: string;
  onQ: (q: string) => void;
  sort: BoardSort;
  onSort: (s: BoardSort) => void;
  filters: readonly BoardFilter[];
  onToggleFilter: (f: BoardFilter) => void;
  canPurchases: boolean;
  attendLabels: { attendedGroup: string; attendedIndividual: string };
}) {
  const t = useTranslations('board');
  return (
    <div className="flex flex-col gap-3" data-testid="board-controls">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" style={{ color: 'var(--text-3)' }} />
          <Input
            type="search"
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder={t('search.placeholder')}
            aria-label={t('search.label')}
            className="pl-10"
            maxLength={100}
            data-testid="board-search"
          />
        </div>
        <Button href="/call" variant="secondary" data-testid="board-call-next">
          <Phone aria-hidden="true" />
          <span className="hidden sm:inline">{t('callNext')}</span>
          <span className="sm:hidden">{t('callNextShort')}</span>
        </Button>
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <Segmented
          label={t('sort.label')}
          className="md:max-w-md"
          items={BOARD_SORTS.map((s) => ({ id: s, label: t(`sort.${s}`), active: sort === s, testId: `sort-${s}` }))}
          onSelect={(id) => onSort(id as BoardSort)}
        />
        <ChipGroup label={t('filters.label')}>
          {availableFilters(canPurchases).map((f) => (
            <Chip key={f} active={filters.includes(f)} onClick={() => onToggleFilter(f)} data-testid={`filter-${f}`}>
              {t(`filters.${f}`, { event: (f === 'attendedGroup' ? attendLabels.attendedGroup : f === 'attendedIndividual' ? attendLabels.attendedIndividual : '') || t('chip.eventUnknown') })}
            </Chip>
          ))}
        </ChipGroup>
      </div>
    </div>
  );
}
