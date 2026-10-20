// Модуль «Настройки продаж» (R2b): единственная точка входа для интерфейса и API.
export { getSalesSettings, patchSalesSettings, putHolidays } from './salesSettings';
export { SalesPatchInput, HolidaysInput, SALES_PATHS, HOLIDAYS_PATH, EVERY_MIN_VALUES, HOLIDAYS_MAX, HOLIDAY_NOTE_MAX } from './salesSettingsPaths';
export type { Holiday } from './salesSettingsPaths';
export { SettingsConflictError, SettingsInvalidError, SettingsNoSpaceError } from './errors';
export type { SalesSettingsView } from './types';
