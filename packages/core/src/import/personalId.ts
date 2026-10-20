// ИИН у форм с «личным» номером (ИП): открыто не хранится и не сравнивается (D-052, D-141).
// Ключ сравнения и хранения — `iin:<HMAC>`, как в `docs/import-design.md` §5–6: так же лежит
// `orgId` у ИП в `known` (из `clients.iin_hmac`). HMAC (ключ `CRM_IIN_HMAC_KEY`) считает сервер.

import { HIDDEN_ORG_ID_PREFIX } from '../dedup/types';
import { IMPORT_FIELDS as F, type ParsedRow } from './types';

export const PERSONAL_ID_PREFIX = HIDDEN_ORG_ID_PREFIX;

/** HMAC от 12 цифр ИИН (синхронный; сервер подставляет `createHmac`). */
export type PersonalIdHmac = (iin: string) => string;

/** Ключ `orgId` для дедупа и хранения: у «личных» — `iin:<HMAC>`, у прочих — БИН как есть. */
export function orgKeyOf(row: Pick<ParsedRow, 'orgId' | 'orgIdPersonal'>, hmac: PersonalIdHmac): string | null {
  if (!row.orgId) return null;
  if (!row.orgIdPersonal) return row.orgId;
  // Уже скрытый ключ (строка прочитана из `import_rows.parsed`) повторно не хэшируется.
  return row.orgId.startsWith(PERSONAL_ID_PREFIX) ? row.orgId : `${PERSONAL_ID_PREFIX}${hmac(row.orgId)}`;
}

/** Строка без открытого ИИН — для `import_rows.parsed`: `orgId` → `iin:<HMAC>`, сырая ячейка очищена. */
export function redactPersonalId(row: ParsedRow, hmac: PersonalIdHmac): ParsedRow {
  if (!row.orgIdPersonal || !row.orgId) return row;
  return { ...row, orgId: orgKeyOf(row, hmac), fields: { ...row.fields, [F.orgId]: '' } };
}
