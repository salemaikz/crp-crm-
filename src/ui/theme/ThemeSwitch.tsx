'use client';
// Личный переключатель вида: «Светлая / Тёмная / Как в системе». Пишет cookie и сразу меняет data-theme
// на <html>, перезагрузка не нужна. Подписи приходят готовыми из локали.
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { Segmented } from '@/ui/kit';
import { THEME_MODES, themeAttribute, themeCookieString, type ThemeMode } from './mode';

export type ThemeSwitchProps = {
  label: string;
  labels: Record<ThemeMode, string>;
  value: ThemeMode;
  /** Компактный вид (боковая колонка): значки, подпись для экранных читалок и подсказка. */
  compact?: boolean;
};

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

export function ThemeSwitch({ label, labels, value, compact = false }: ThemeSwitchProps) {
  const [mode, setMode] = useState<ThemeMode>(value);
  function select(id: string) {
    const next = THEME_MODES.find((m) => m === id);
    if (!next) return;
    setMode(next);
    document.cookie = themeCookieString(next);
    const attr = themeAttribute(next);
    if (attr) document.documentElement.setAttribute('data-theme', attr);
    else document.documentElement.removeAttribute('data-theme');
  }
  return (
    <Segmented
      label={label}
      onSelect={select}
      items={THEME_MODES.map((m) => {
        const Icon = ICONS[m];
        return {
          id: m,
          testId: `theme-${m}`,
          active: mode === m,
          label: compact ? (
            <span title={labels[m]} className="inline-flex items-center">
              <Icon size={16} aria-hidden="true" />
              <span className="sr-only">{labels[m]}</span>
            </span>
          ) : (
            labels[m]
          ),
        };
      })}
    />
  );
}
