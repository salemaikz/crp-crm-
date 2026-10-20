// Проверка подписи пакета и лицензии. ЗАГЛУШКА: настоящие проверки реализуют O4c (подпись пакета,
// Ed25519 по manifest.sig, доверенные ключи) и P10 (формат лицензии, состояния, водяной знак).
// Пока заглушка закрыта по умолчанию (fail closed): без явного разрешения обновление не идёт.
// CRM_VERIFY_STUB=allow пропускает проверку — только для стенда и тестов; O4c/P10 уберут эту ветку.
import type { Verdict, Verifier } from './types';

export function stubVerifier(env: Record<string, string | undefined>): Verifier {
  const verdict = (what: string): Verdict =>
    env.CRM_VERIFY_STUB === 'allow'
      ? { ok: true }
      : { ok: false, reason: `проверка ${what} не реализована (O4c/P10); для стенда CRM_VERIFY_STUB=allow` };
  return {
    verifyPackage: async () => verdict('подписи пакета'),
    verifyLicense: async () => verdict('лицензии'),
  };
}
