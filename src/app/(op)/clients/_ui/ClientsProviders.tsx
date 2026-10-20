'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ToastProvider } from '@/ui/kit';

/**
 * Общее состояние ленты карточки: выбранная сделка (лента сделки) и счётчик «обновить ленту». Заметки и
 * сделки живут в своих панелях, а лента — в своей: через этот контекст они не знают друг о друге.
 */
type FeedControl = {
  dealId: string | null;
  setDealId: (id: string | null) => void;
  rev: number;
  reload: () => void;
};

const FeedControlContext = createContext<FeedControl | null>(null);

export function useFeedControl(): FeedControl {
  const v = useContext(FeedControlContext);
  if (!v) throw new Error('useFeedControl: нет ClientsProviders');
  return v;
}

// Тосты страниц клиентов. Когда у оператора появится общая оболочка, провайдер переедет в неё.
export function ClientsProviders({ children }: { children: ReactNode }) {
  const [dealId, setDealId] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((n) => n + 1), []);
  const value = useMemo(() => ({ dealId, setDealId, rev, reload }), [dealId, rev, reload]);
  return (
    <ToastProvider>
      <FeedControlContext.Provider value={value}>{children}</FeedControlContext.Provider>
    </ToastProvider>
  );
}
