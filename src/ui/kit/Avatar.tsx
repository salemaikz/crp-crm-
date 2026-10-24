// Источник: платформа LMS 2cd8a2b src/components/ui/Avatar.tsx (адаптировано под CRM)
import { cn } from './cn';

type Props = {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
};

/** Инициалы: «Айдар Тулеев» → «АТ», «admin@example.com» → «A». */
export function initials(name: string): string {
  const clean = name.trim().split('@')[0] ?? '';
  const words = clean.split(/[\s._-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

/** Аватар-кружок с инициалами (декоративный: имя рядом выводится текстом). */
export function Avatar({ name, size = 'md', className }: Props) {
  return (
    <span className={cn('k-avatar', size !== 'md' && `k-avatar--${size}`, className)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
