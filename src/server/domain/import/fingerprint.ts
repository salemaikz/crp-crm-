// Отпечаток предпросмотра (дизайн C4d §6.2, D-113): sha256 канонического JSON. Меняется, если изменилось
// что-либо, от чего зависит запись: сборка, ревизии настроек, карта владельцев, решение по любой строке.
// По плану — core/import/fingerprint.ts (C4-core); хэш внедряется параметром, ядро остаётся чистым.
import type { imports } from '@crm/core';

export interface FingerprintInput {
  buildId: string;
  configRev: { global: number; space: number };
  importId: string;
  fileSha256: string;
  profileKey: string;
  snapshotDay: string;
  ownerMap: Readonly<Record<string, string | undefined>>;
  rows: readonly imports.PreviewRow[];
}

/** JSON с отсортированными ключами объектов: порядок вставки не влияет на результат. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function previewFingerprint(input: FingerprintInput, sha256: (s: string) => string): string {
  const ownerMap = Object.fromEntries(Object.entries(input.ownerMap).filter(([, v]) => !!v));
  const body = {
    v: 1,
    buildId: input.buildId,
    configRev: input.configRev,
    importId: input.importId,
    fileSha256: input.fileSha256,
    profileKey: input.profileKey,
    snapshotDay: input.snapshotDay,
    ownerMap,
    rows: input.rows.map((r) => [
      r.rowNo,
      r.action,
      r.hold,
      r.ownerUserId,
      r.matchId,
      r.pairs.map((p) => [p.id, p.reason]),
      r.outcomeKey,
      r.agreedWithoutBooking,
      r.stoppedPhones,
    ]),
  };
  return sha256(canonicalJson(body));
}
