import type { ReactNode } from 'react';

// Экраны без сессии и личный кабинет: одна колонка, крупные поля, мобильный экран первым.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">{children}</main>;
}
