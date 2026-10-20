// Проверка лицензии офлайн (D-029, D-211): разбор → ключ по kid → подпись Ed25519 → установка, клиент, сборка.
// Срок здесь не проверяется: время — отдельное правило (clock.ts) и состояния (state.ts).
import { verify as edVerify } from 'node:crypto';
import { decodeLicense, type InvalidReason, type LicensePayload } from './format';
import { isTestKid, publicKeyObject, type TrustedKeys, type Watermark } from './keys';

export type Verdict = { ok: true; license: LicensePayload } | { ok: false; reason: InvalidReason };

export type VerifyExpect = {
  /** installId этой установки (license_state.install_id). */
  installId: string;
  keys: TrustedKeys;
  watermark: Watermark;
};

export function verifyLicense(raw: string, expect: VerifyExpect): Verdict {
  return check(raw, expect, true);
}

/**
 * Опора льготы `wrong_build` (D-290): копия license_raw из БД, заново проверенная подписью, installId и клиентом.
 * Строке license_state не доверяем: опорой служит только то, что подписал владелец для этой установки.
 * buildId не сверяется — льгота и нужна, когда лицензия, привязанная к прежней сборке, перестала сходиться
 * после обновления. Срок проверяет evaluateLicense (buildGraceUntil). null — копии нет или она не проходит проверку.
 */
export function verifyStoredCopy(raw: string, expect: VerifyExpect): LicensePayload | null {
  if (raw.trim() === '') return null;
  const v = check(raw, expect, false);
  return v.ok ? v.license : null;
}

function check(raw: string, expect: VerifyExpect, checkBuild: boolean): Verdict {
  const d = decodeLicense(raw);
  if (!d.ok) return d;
  const { payload, signed, signature } = d.value;
  const keyB64 = Object.prototype.hasOwnProperty.call(expect.keys, payload.kid) ? expect.keys[payload.kid] : undefined;
  if (!keyB64) return { ok: false, reason: 'unknown_kid' };
  // Сборка клиента не доверяет тестовым ключам, даже если их по ошибке вшили
  if (expect.watermark.customer !== null && isTestKid(payload.kid)) return { ok: false, reason: 'test_key_in_client_build' };
  let good = false;
  try {
    good = edVerify(null, signed, publicKeyObject(keyB64), signature);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad_signature' };
  if (payload.installId !== expect.installId) return { ok: false, reason: 'wrong_install' };
  if (expect.watermark.customer !== null && payload.customer !== expect.watermark.customer) return { ok: false, reason: 'wrong_customer' };
  if (checkBuild && payload.buildId !== undefined && payload.buildId !== expect.watermark.buildId) return { ok: false, reason: 'wrong_build' };
  return { ok: true, license: payload };
}
