'use client';

// Шапка доски (pipeline-v2 §9.4, ui-polish §9.6).
// Телефон: одна строка — поиск и две кнопки-значка: «Сортировка» (шторка, только на вкладках рабочих колонок) и
// «Фильтры · N» (шторка с чипами и «Сбросить»); выбранные фильтры — строкой чипов под поиском. «Звонить подряд» с
// телефона убран: он есть в нижнем меню.
// Ноутбук: одна строка с переносом — поиск, сортировка, у доски пространства «Сотрудник» и «Причина», чипы, «Сбросить (N)»;
// справа «Звонить подряд» (оператору) и «?» со ссылкой на раздел справки о доске.
import { ArrowUpDown, CircleHelp, ListFilter, Phone, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BottomSheet, Button, Chip, ChipGroup, Input, Segmented, Select } from '@/ui/kit';
import { availableFilters } from './order';
import { useWide } from './useWide';
import { BOARD_SORTS, type BoardExtra, type BoardFilter, type BoardSort } from './types';

export function BoardControls({
  q,
  onQ,
  sort,
  onSort,
  filters,
  onToggleFilter,
  canPurchases,
  attendLabels,
  manager,
  extra,
  onExtra,
  reasonLabels,
  active,
  onReset,
  sortApplies,
}: {
  q: string;
  onQ: (q: string) => void;
  sort: BoardSort;
  onSort: (s: BoardSort) => void;
  filters: readonly BoardFilter[];
  onToggleFilter: (f: BoardFilter) => void;
  canPurchases: boolean;
  attendLabels: { attendedGroup: string; attendedIndividual: string };
  /** Доска пространства (РОП, директор): фильтры «сотрудник» и «причина перезвона»; у оператора не передаётся. */
  manager?: { owners: { userId: string; name: string }[] } | undefined;
  extra?: BoardExtra;
  onExtra?: (e: BoardExtra) => void;
  reasonLabels?: Record<string, string>;
  /** Сколько признаков вида включено (фильтры, сотрудник, причина, поиск). */
  active: number;
  onReset: () => void;
  /** Сортировка действует на выбранной вкладке (рабочие роли); на телефоне иначе кнопки сортировки нет. */
  sortApplies: boolean;
}) {
  const t = useTranslations('board');
  const wide = useWide();
  const [sheet, setSheet] = useState<'sort' | 'filters' | null>(null);

  const filterLabel = (f: BoardFilter) =>
    t(`filters.${f}`, { event: (f === 'attendedGroup' ? attendLabels.attendedGroup : f === 'attendedIndividual' ? attendLabels.attendedIndividual : '') || t('chip.eventUnknown') });
  const chips = (only?: readonly BoardFilter[]) =>
    (only ?? availableFilters(canPurchases)).map((f) => (
      <Chip key={f} active={filters.includes(f)} onClick={() => onToggleFilter(f)} data-testid={`filter-${f}`}>
        {filterLabel(f)}
      </Chip>
    ));
  const managerSelects = manager && extra && onExtra && (
    <>
      <Select aria-label={t('manager.owner')} value={extra.owner} onChange={(e) => onExtra({ ...extra, owner: e.target.value })} className="md:w-auto md:min-w-44" data-testid="filter-owner">
        <option value="">{t('manager.allOwners')}</option>
        {manager.owners.map((o) => (
          <option key={o.userId} value={o.userId}>
            {o.name}
          </option>
        ))}
      </Select>
      <Select aria-label={t('manager.reason')} value={extra.callbackReason} onChange={(e) => onExtra({ ...extra, callbackReason: e.target.value })} className="md:w-auto md:min-w-44" data-testid="filter-reason">
        <option value="">{t('manager.allReasons')}</option>
        {Object.entries(reasonLabels ?? {}).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </Select>
    </>
  );

  const search = (
    <div className="relative min-w-0 flex-1 md:w-56 md:flex-none">
      <Search aria-hidden="true" size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" style={{ color: 'var(--text-3)' }} />
      <Input type="search" value={q} onChange={(e) => onQ(e.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.label')} className="pl-10" maxLength={100} data-testid="board-search" />
    </div>
  );

  if (!wide) {
    return (
      <div className="flex flex-col gap-2" data-testid="board-controls">
        <div className="flex items-center gap-2">
          {search}
          {sortApplies && (
            <Button variant="secondary" iconOnly aria-label={t('sort.label')} onClick={() => setSheet('sort')} data-testid="board-sort-open">
              <ArrowUpDown aria-hidden="true" />
            </Button>
          )}
          <Button variant="secondary" iconOnly aria-label={active > 0 ? t('filters.openCount', { n: active }) : t('filters.label')} onClick={() => setSheet('filters')} className="relative" data-testid="board-filters-open">
            <ListFilter aria-hidden="true" />
            {active > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full text-xs font-semibold" style={{ background: 'var(--accent-ink)', color: 'var(--surface)' }} aria-hidden="true">
                {active}
              </span>
            )}
          </Button>
        </div>
        {filters.length > 0 && (
          <ChipGroup label={t('filters.selected')} data-testid="board-selected-filters">
            {filters.map((f) => (
              <Chip key={f} active onClick={() => onToggleFilter(f)} aria-label={t('filters.remove', { name: filterLabel(f) })} data-testid={`selected-${f}`}>
                {filterLabel(f)}
                <X size={14} aria-hidden="true" />
              </Chip>
            ))}
          </ChipGroup>
        )}
        <BottomSheet open={sheet === 'sort'} onClose={() => setSheet(null)} closeLabel={t('sheet.close')} title={t('sort.label')}>
          <Segmented
            label={t('sort.label')}
            className="w-full"
            items={BOARD_SORTS.map((s) => ({ id: s, label: t(`sort.${s}`), active: sort === s, testId: `sort-${s}` }))}
            onSelect={(id) => {
              onSort(id as BoardSort);
              setSheet(null);
            }}
          />
        </BottomSheet>
        <BottomSheet
          open={sheet === 'filters'}
          onClose={() => setSheet(null)}
          closeLabel={t('sheet.close')}
          title={t('filters.label')}
          footer={
            <div className="flex gap-2">
              {active > 0 && (
                <Button variant="secondary" onClick={onReset} data-testid="filters-reset">
                  {t('filters.reset')}
                </Button>
              )}
              <Button size="lg" block onClick={() => setSheet(null)} data-testid="filters-done">
                {t('filters.done')}
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4" data-testid="board-filters-sheet">
            {manager && extra && onExtra && (
              <div className="flex flex-col gap-2" data-testid="board-manager-filters">
                {managerSelects}
              </div>
            )}
            <ChipGroup label={t('filters.label')} className="flex-wrap">
              {chips()}
            </ChipGroup>
          </div>
        </BottomSheet>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="board-controls">
      {search}
      <Select aria-label={t('sort.label')} value={sort} onChange={(e) => onSort(e.target.value as BoardSort)} className="w-auto min-w-40" data-testid="sort-select">
        {BOARD_SORTS.map((s) => (
          <option key={s} value={s}>
            {t(`sort.${s}`)}
          </option>
        ))}
      </Select>
      {manager && extra && onExtra && (
        <div className="contents" data-testid="board-manager-filters">
          {managerSelects}
        </div>
      )}
      <ChipGroup label={t('filters.label')} className="flex-wrap overflow-visible">
        {chips()}
      </ChipGroup>
      {active > 0 && (
        <Button variant="quiet" onClick={onReset} data-testid="filters-reset">
          {t('filters.resetCount', { n: active })}
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        {!manager && (
          <Button href="/call" variant="secondary" data-testid="board-call-next">
            <Phone aria-hidden="true" />
            <span>{t('callNext')}</span>
          </Button>
        )}
        <Button href="/help#board" variant="quiet" iconOnly aria-label={t('help.aria')} title={t('help.aria')} data-testid="board-help">
          <CircleHelp aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
