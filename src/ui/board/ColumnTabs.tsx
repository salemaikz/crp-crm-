'use client';

// Липкая полоса вкладок колонок на телефоне: подпись и число, прокрутка синхронизирована со свайпом (BoardScreen).
export interface TabView {
  key: string;
  title: string;
  count: number;
  more: boolean;
}

export interface TabDrop {
  /** Идёт перенос: вкладка — цель (`ok`), запрещена (`no`) или не участвует. */
  state: 'idle' | 'ok' | 'no';
  /** Палец над этой целью. */
  over: boolean;
}

export function ColumnTabs({ label, tabs, active, onSelect, drops }: { label: string; tabs: readonly TabView[]; active: string; onSelect: (key: string) => void; drops?: Record<string, TabDrop> }) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="sticky top-0 z-10 -mx-[var(--gutter)] flex gap-1 overflow-x-auto px-[var(--gutter)] py-2 md:hidden"
      style={{ background: 'var(--canvas)', borderBottom: '1px solid var(--border)' }}
      data-testid="column-tabs"
    >
      {tabs.map((tab) => {
        const drop = drops?.[tab.key];
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === active}
            className="k-chip shrink-0"
            data-active={selected ? '1' : undefined}
            data-tab-key={tab.key}
            data-drop={drop?.state === 'idle' ? undefined : drop?.state}
            style={{
              ...(selected ? { background: 'var(--brand)', color: 'var(--on-brand)', borderColor: 'var(--brand)' } : {}),
              // Перенос плитки: разрешённые вкладки обведены пунктиром, запрещённые гаснут (§9.2)
              ...(drop?.state === 'ok' ? { outline: '2px dashed var(--brand)', outlineOffset: 1 } : {}),
              ...(drop?.state === 'no' ? { opacity: 0.4 } : {}),
              ...(drop?.over ? { background: 'var(--brand-tint)' } : {}),
            }}
            onClick={() => onSelect(tab.key)}
            data-testid={`tab-${tab.key}`}
          >
            {tab.title}
            <span className="k-chip__count">{tab.more ? `${tab.count}+` : tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}
