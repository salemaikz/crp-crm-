'use client';

import { useEffect, useRef } from 'react';

// Липкая полоса вкладок колонок на телефоне: подпись и число, прокрутка синхронизирована со свайпом (BoardScreen).
// Слой --z-sticky и фон --canvas (ui-polish §9.1): кнопки плиток лежат внутри своих isolate-плиток и выше не поднимаются.
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
  const list = useRef<HTMLDivElement>(null);
  // Выбранная вкладка (свайпом или нажатием) прокручивается в видимую область ряда, не двигая страницу
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(active)}"]`);
    const box = list.current;
    if (!el || !box || box.clientWidth === 0) return;
    const left = el.offsetLeft;
    if (left < box.scrollLeft) box.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
    else if (left + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollTo({ left: left + el.offsetWidth - box.clientWidth + 16, behavior: 'smooth' });
  }, [active]);
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className="sticky top-0 z-[var(--z-sticky)] -mx-[var(--gutter)] flex gap-1 overflow-x-auto px-[var(--gutter)] pt-2 md:hidden"
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
            className="k-tab"
            data-active={selected ? '1' : undefined}
            data-tab-key={tab.key}
            data-drop={drop?.state === 'idle' ? undefined : drop?.state}
            style={{
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
