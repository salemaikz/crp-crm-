import { computeTheme, themeToCss, themeToCssDark } from './compute';

type Props = {
  /** Раздел `theme` активных настроек (getActiveConfig().theme); любой мусор безопасен. */
  settings: unknown;
  nonce?: string;
  /** Флаг THEME_DARK. Выключен — только светлая тема, без медиазапроса и тёмного блока. */
  darkEnabled?: boolean;
};

/**
 * Серверный компонент: кладёт в <head> переменные темы. Подключается в корневом layout
 * после tokens.css — значения из настроек перекрывают значения по умолчанию.
 * Тёмная тема: явный `data-theme="dark"` и «как в системе» (медиазапрос, пока нет `data-theme="light"`).
 */
export function ThemeStyle({ settings, nonce, darkEnabled = false }: Props) {
  const { vars } = computeTheme(settings, 'light');
  let css = themeToCss(vars);
  if (darkEnabled) {
    const dark = computeTheme(settings, 'dark').vars;
    css += themeToCssDark(vars, dark, ':root[data-theme="dark"]');
    css += `@media (prefers-color-scheme: dark){${themeToCssDark(vars, dark, ':root:not([data-theme="light"])')}}`;
  }
  return <style id="crm-theme" nonce={nonce} dangerouslySetInnerHTML={{ __html: css }} />;
}
