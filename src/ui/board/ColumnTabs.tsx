'use client';

// Липкая полоса вкладок колонок на телефоне: подпись и число, прокрутка синхронизирована со свайпом (BoardScreen).
import { cn } from '@/ui/kit';

export interface TabView {
  key: string;
  title: string;
  count: number;
  more: boolean;
}

export function ColumnTabs({ label, tabs, active, onSelect }: { label: string; tabs: readonly TabView[]; active: string; onSelect: (key: string) => void }) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="sticky top-0 z-10 -mx-[var(--gutter)] flex gap-1 overflow-x-auto px-[var(--gutter)] py-2 md:hidden"
      style={{ background: 'var(--canvas)', borderBottom: '1px solid var(--border)' }}
      data-testid="column-tabs"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          className={cn('k-chip shrink-0')}
          aria-pressed={undefined}
          data-active={tab.key === active ? '1' : undefined}
          style={tab.key === active ? { background: 'var(--brand)', color: 'var(--on-brand)', borderColor: 'var(--brand)' } : undefined}
          onClick={() => onSelect(tab.key)}
          data-testid={`tab-${tab.key}`}
        >
          {tab.title}
          <span className="k-chip__count">{tab.more ? `${tab.count}+` : tab.count}</span>
        </button>
      ))}
    </div>
  );
}
