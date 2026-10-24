// Цвет плитки: заливка тона и полоса 6 px (D-358 п. 2). Полоса — внутренняя тень, а не рамка: рамка 1 px у всех плиток
// одинакова, поэтому левая граница текста у белых и цветных плиток совпадает.
import type { CSSProperties } from 'react';
import type { Tone } from './tile';

export function toneStyle(tone: Tone | null): CSSProperties {
  const base: CSSProperties = { borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)' };
  // Без тона — обычная плитка без полосы: так тон не тонет среди одинаковых полос
  if (!tone) return { ...base, background: 'var(--surface)' };
  if (tone === 'neutral') return { ...base, background: 'var(--canvas)', boxShadow: 'inset 6px 0 0 0 var(--border-strong)' };
  return { ...base, background: `var(--${tone}-tile)`, boxShadow: `inset 6px 0 0 0 var(--${tone})` };
}
