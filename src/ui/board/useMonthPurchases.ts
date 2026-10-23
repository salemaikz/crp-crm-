'use client';

// Итог месяца для шапки колонки «Покупка» (pipeline-v2 §9.5): число и сумма засчитанных сделок оператора
// (`GET /api/deals/mine`, отбор по заслуге на сервере). Данные нигде не сохраняются; нет сети или права — итога нет.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface MonthPurchases {
  count: number;
  sumKzt: number;
}

export function useMonthPurchases(enabled: boolean, fetchFn: typeof fetch): MonthPurchases | null {
  const [month, setMonth] = useState<MonthPurchases | null>(null);
  const fetchRef = useRef(fetchFn);
  useEffect(() => {
    fetchRef.current = fetchFn;
  });

  const load = useCallback(async () => {
    try {
      const res = await fetchRef.current('/api/deals/mine', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const body = (await res.json()) as { month?: { count?: unknown; sumKzt?: unknown } };
      const count = Number(body.month?.count);
      const sumKzt = Number(body.month?.sumKzt);
      if (Number.isFinite(count) && Number.isFinite(sumKzt)) setMonth({ count, sumKzt });
    } catch {
      // без сети остаётся прежний итог
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const h = setTimeout(() => void load(), 0);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(h);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, load]);

  return enabled ? month : null;
}
