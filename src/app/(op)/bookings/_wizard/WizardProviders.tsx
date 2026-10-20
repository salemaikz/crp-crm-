'use client';

import type { ReactNode } from 'react';
import { ToastProvider } from '@/ui/kit';

// Тосты страницы мастера (на странице нет общей оболочки с провайдером в прогоне изоляции). Во вложенном
// месте (шторка итога) ближайший провайдер просто перехватывает тосты мастера.
export function WizardProviders({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
