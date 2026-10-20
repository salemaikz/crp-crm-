// Состояние лицензии для обёрток доступа и воркера (P10, ARCHITECTURE §8.4, D-029, D-211).
// read_only, invalid, missing → мутации 423 (кроме D-054, wrappers.ts); grace — всё работает.
// Подпись проверяется заново при каждом пересчёте (раз в минуту на процесс): правка поля state в БД
// состояние не меняет. Выгрузка данных лицензией не блокируется никогда (D-055).
import { currentLicenseSnapshot } from '@/server/platform/license/current';
import type { LicenseState } from './types';

export async function currentLicenseState(): Promise<LicenseState> {
  return (await currentLicenseSnapshot()).access;
}
