import { computeTheme, themeToCss } from './compute';

type Props = {
  /** Раздел `theme` активных настроек (getActiveConfig().theme); любой мусор безопасен. */
  settings: unknown;
  nonce?: string;
};

/**
 * Серверный компонент: кладёт в <head> переменные темы. Подключается в корневом layout
 * после tokens.css — значения из настроек перекрывают значения по умолчанию.
 */
export function ThemeStyle({ settings, nonce }: Props) {
  const { vars } = computeTheme(settings);
  return <style id="crm-theme" nonce={nonce} dangerouslySetInnerHTML={{ __html: themeToCss(vars) }} />;
}
