// Отпечаток предпросмотра «Записи» (D-324, D-113): sha256 канонического JSON. Меняется, если изменилось всё,
// от чего зависит запись: сборка, ревизии настроек, день, карта авторов, решение по любой строке — клиент,
// карточка, мероприятие, автор, переход и владелец. Новый клиент из приёма, запись из мастера, правка мест,
// смена владельца и другой день дают другой отпечаток. Хэш внедряется параметром: ядро остаётся чистым.

import { normalizeLabel } from './answer';
import type { AuthorMap } from './bookingMatch';
import type { BookingPreviewRow } from './bookingPreview';

/** JSON с отсортированными ключами объектов: порядок вставки не влияет на результат. */
export function canonicalJsonOf(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJsonOf).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonOf(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export interface BookingFingerprintInput {
  buildId: string;
  configRev: { global: number; space: number };
  importId: string;
  fileSha256: string;
  profileKey: string;
  snapshotDay: string;
  today: string;
  authorMap: AuthorMap;
  rows: readonly BookingPreviewRow[];
}

/** Карта авторов в канонической форме: ключи нормализованы, нерешённые убраны, `null` («неизвестен») сохранён. */
export function canonicalAuthorMap(map: AuthorMap): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && normalizeLabel(k) !== '') out[normalizeLabel(k)] = v;
  }
  return out;
}

export function bookingPreviewFingerprint(input: BookingFingerprintInput, sha256: (s: string) => string): string {
  const body = {
    v: 1,
    kind: 'bookings',
    buildId: input.buildId,
    configRev: input.configRev,
    importId: input.importId,
    fileSha256: input.fileSha256,
    profileKey: input.profileKey,
    snapshotDay: input.snapshotDay,
    today: input.today,
    authorMap: canonicalAuthorMap(input.authorMap),
    rows: input.rows.map((r) => [r.rowNo, r.action, r.flags, r.clientId, r.cardId, r.eventId, r.authorUserId, r.transition, r.ownerAfter]),
  };
  return sha256(canonicalJsonOf(body));
}
