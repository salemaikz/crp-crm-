/** Склейка классов: пропускает false/null/undefined/''. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
