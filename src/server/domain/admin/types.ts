// Вид настроек продаж для экрана и API (R2b). Без значений вне белого списка.
import type { Holiday } from './salesSettingsPaths';

export type SalesSettingsView = {
  /** Ревизии областей на момент чтения: экран возвращает их в `expectedRev`. `space` = 0, если пространства нет. */
  revs: { global: number; space: number };
  values: {
    /** null — пространство не определено (администратор без роли). */
    dailyCap: number | null;
    schedule: { from: string; to: string; everyMin: number } | null;
    callWindow: { start: string; end: string };
    callsPerHourTarget: number | null;
  };
  holidays: Holiday[];
  can: { sales: boolean; holidays: boolean };
  /** Текущий год в поясе установки: праздники показываются на этот и следующий. */
  year: number;
};
