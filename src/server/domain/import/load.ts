// Входы предпросмотра и сам предпросмотр (дизайн C4d §6): строки из import_rows + состояние БД →
// imports.buildPreview → отпечаток. Бизнес-таблицы не меняются; вызывается и при предпросмотре, и внутри
// транзакции применения (там вход читается заново под блокировками).
import { createHash } from 'node:crypto';
import { dedup, imports, names, time } from '@crm/core';
import type { Sql } from '@/server/platform/db/core';
import { previewFingerprint } from './fingerprint';
import { buildId, iinHmac, phoneHmac } from './platformGlue';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { ImportProfileSetting, OwnerMap } from './types';

/** Время импортного звонка: день снимка 18:00 по поясу установки, но не позже now. */
export function occurredAtOf(snapshotDay: string, timeZone: string, now: number): number {
  return Math.min(time.fromLocalTime(snapshotDay, '18:00', timeZone), now);
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Скрытый ключ ИИН в `orgId` разобранной строки (D-052). */
const HIDDEN = dedup.HIDDEN_ORG_ID_PREFIX;

export interface PriorLink {
  clientId: string;
  cardId: string;
  /** Карточка без владельца и без задержки: повтор строки назначает ей владельца, как `create` (D-222). */
  ownerless: boolean;
}

export interface Computation {
  profile: ImportProfileSetting;
  rows: imports.ParsedRow[];
  rowByNo: Map<number, imports.ParsedRow>;
  preview: imports.ImportPreview;
  fingerprint: string;
  known: dedup.KnownCompany[];
  stopHits: Set<string>;
  priorLinks: Map<string, PriorLink>;
  /** Нормализованные карты ярлык → id (пустые отброшены). */
  ownerMap: Record<string, string>;
}

export function cleanOwnerMap(m: OwnerMap): Record<string, string> {
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => k.trim() !== '' && typeof v === 'string' && v !== ''));
}

/** HMAC номера с запоминанием: один номер считается один раз. */
export function memoPhoneHmac(): (digits: string) => string {
  const memo = new Map<string, string>();
  return (d) => {
    let h = memo.get(d);
    if (h === undefined) memo.set(d, (h = phoneHmac(d)));
    return h;
  };
}

export async function computePreview(
  sql: Sql,
  ctx: ImportContext,
  imp: { id: string; fileSha256: string; profileKey: string; report: { input: { snapshotDay: string } } },
  stored: readonly repo.StoredRow[],
  ownerMapIn: OwnerMap,
): Promise<Computation> {
  const profile = ctx.settings.profiles.find((p) => p.key === imp.profileKey);
  if (!profile) throw new Error('profile_gone');
  const rows = stored.map((r) => r.parsed as imports.ParsedRow);
  const ownerMap = cleanOwnerMap(ownerMapIn);
  const hash = memoPhoneHmac();

  // Ключи кандидатов: открытые БИН, HMAC ИИН, номера (рабочие и заглушки), нормализованные названия
  const orgIds = new Set<string>();
  const iins = new Set<string>();
  const phones = new Set<string>();
  const nameNorms = new Set<string>();
  for (const r of rows) {
    if (r.orgId) {
      if (r.orgId.startsWith(HIDDEN)) iins.add(r.orgId.slice(HIDDEN.length));
      else if (!r.orgIdPersonal) orgIds.add(r.orgId);
    }
    for (const p of r.workingPhones) phones.add(p);
    for (const p of r.stubPhones) phones.add(p);
    if (r.nameNorm) nameNorms.add(r.nameNorm);
  }
  const headKey = profile.fieldTargets.head?.object === 'client' ? profile.fieldTargets.head.fieldKey : null;
  const cands = await repo.selectCandidates(sql, { orgIds: [...orgIds], iinHmacs: [...iins], phones: [...phones], nameNorms: [...nameNorms], headKey });
  const codeOf = (key: string): string => {
    for (const [code, k] of ctx.legalKeyByCode) if (k === key) return code;
    return '';
  };
  const known: dedup.KnownCompany[] = cands.map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    orgId: c.orgId || (c.iinHmac ? `${HIDDEN}${c.iinHmac}` : null),
    legalForm: codeOf(c.legalForm),
    phones: c.phones,
    stubPhones: c.stubs,
    nameNorm: c.nameNorm,
    headNorm: c.head ? names.normalizePersonName(c.head) : '',
  }));
  const stopHits = await repo.selectStopListHits(sql, [...new Set(rows.flatMap((r) => r.workingPhones))].map(hash));
  const priorRows = await repo.selectPrior(sql, ctx.spaceId, ctx.settings.sourceKey, rows.map((r) => r.rowKey));
  const prior = new Map<string, imports.PriorImportRow>();
  const priorLinks = new Map<string, PriorLink>();
  // Первая строка файла с ключом — та, что дойдёт до решения о повторе (остальные — duplicate_in_file)
  const firstByKey = new Map<string, imports.ParsedRow>();
  for (const r of rows) if (!firstByKey.has(r.rowKey)) firstByKey.set(r.rowKey, r);
  for (const p of priorRows) {
    const ownerless = p.ownerUserId === null && p.holdReason === '';
    const row = firstByKey.get(p.rowKey);
    const slot = ownerless && row ? imports.resolveOwner(row.rowNo, row.operatorLabel, profile.ownerBy, ownerMap).kind : null;
    // Отложенный итог применим, если карточку не задержали и владелец есть или найдётся. Несопоставленный ярлык
    // тоже «найдётся»: строка станет update_state, а ярлык — блокером unmapped_slots (D-222).
    const deferredResumable = p.deferred && p.holdReason === '' && (p.ownerUserId !== null || slot === 'assigned' || slot === 'unmapped');
    prior.set(p.rowKey, { rowKey: p.rowKey, stateKey: p.stateKey, touchedInCrm: p.touchedInCrm, deferredResumable });
    priorLinks.set(p.rowKey, { clientId: p.clientId, cardId: p.cardId, ownerless });
  }
  const preview = imports.buildPreview({
    rows,
    profile: { ownerBy: profile.ownerBy },
    ownerMap,
    known,
    dedup: ctx.dedup,
    stopList: { hash, lookup: stopHits },
    rules: ctx.settings.rules,
    prior,
    personalIdHmac: iinHmac,
  });
  assignResumedOwners(preview, rows, profile, ownerMap, priorLinks);
  const fingerprint = previewFingerprint(
    {
      buildId: buildId(),
      configRev: ctx.rev,
      importId: imp.id,
      fileSha256: imp.fileSha256,
      profileKey: imp.profileKey,
      snapshotDay: imp.report.input.snapshotDay,
      ownerMap,
      rows: preview.rows,
    },
    sha256,
  );
  return { profile, rows, rowByNo: new Map(rows.map((r) => [r.rowNo, r])), preview, fingerprint, known, stopHits, priorLinks, ownerMap };
}

/**
 * Владелец для `update_state` по карточке без владельца и без задержки (D-222): тот же, что получила бы строка
 * при `create` (слот или колонка «оператор»). Ядро решает владельца только для новых строк, поэтому
 * дописываем здесь, до отпечатка: «каждому оператору N» и блокер несопоставленных ярлыков видят и эти строки.
 */
function assignResumedOwners(
  preview: imports.ImportPreview,
  rows: readonly imports.ParsedRow[],
  profile: ImportProfileSetting,
  ownerMap: Record<string, string>,
  priorLinks: ReadonlyMap<string, PriorLink>,
): void {
  const byNo = new Map(rows.map((r) => [r.rowNo, r]));
  const unmapped = new Set(preview.unmappedSlots);
  for (const pr of preview.rows) {
    if (pr.action !== 'update_state') continue;
    const row = byNo.get(pr.rowNo);
    if (!row || !priorLinks.get(row.rowKey)?.ownerless) continue;
    const owner = imports.resolveOwner(row.rowNo, row.operatorLabel, profile.ownerBy, ownerMap);
    pr.ownerKind = owner.kind;
    if (owner.kind === 'assigned') {
      pr.ownerUserId = owner.userId;
      preview.perOperator[owner.userId] = (preview.perOperator[owner.userId] ?? 0) + 1;
    } else if (owner.kind === 'unmapped') {
      for (const l of owner.slots) unmapped.add(l);
    }
  }
  preview.unmappedSlots = [...unmapped].sort();
}

/** Хэш ярлыка для `report.preview.ownerMapRef`: имена сотрудников-ярлыков в отчёт не пишутся. */
export const labelRef = (label: string): string => sha256(imports.normalizeLabel(label)).slice(0, 16);

/** Ярлыки карты владельцев: слоты профиля или значения колонки «оператор». */
export function ownerLabelsOf(profile: ImportProfileSetting, rows: readonly imports.ParsedRow[]): string[] {
  if (profile.ownerBy.kind === 'row_ranges') return profile.ownerBy.slots.map((s) => s.label);
  const seen = new Map<string, string>();
  for (const r of rows) {
    const l = r.operatorLabel?.trim();
    if (l && !seen.has(imports.normalizeLabel(l))) seen.set(imports.normalizeLabel(l), l);
  }
  return [...seen.values()];
}
