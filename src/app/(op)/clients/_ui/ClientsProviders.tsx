'use client';

import type { ReactNode } from 'react';
import { ToastProvider } from '@/ui/kit';

// Тосты страниц клиентов. Когда у оператора появится общая оболочка, провайдер переедет в неё.
export function ClientsProviders({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
