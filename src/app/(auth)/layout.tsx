import type { ReactNode } from 'react';
import { Page } from '@/ui/kit';

// Экраны без сессии и личный кабинет: одна колонка по центру (Page focus), мобильный экран первым.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <Page width="focus" className="min-h-dvh justify-center">
      {children}
    </Page>
  );
}
