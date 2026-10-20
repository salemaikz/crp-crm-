// Место под состояние лицензии (P10, ARCHITECTURE §8.4). До P10 лицензия считается действующей:
// заглушка не блокирует ничего. P10 заменяет тело на чтение license_state (с кэшем процесса) и
// оставляет сигнатуру; обёртки уже отклоняют мутации при read_only/invalid/missing (кроме D-054).
import type { LicenseState } from './types';

export async function currentLicenseState(): Promise<LicenseState> {
  return 'valid';
}
