// Приём партии лидов (INTEGRATIONS 5.2): одна транзакция под общей блокировкой приёма.
// Порядок для каждой записи — как у импорта (PROCESS 2.3): поля → правило отклонения → стоп-лист → дедуп → правило
// задержки → создание. Раздачи при приёме нет (PROCESS 7.2): карточки ложатся в пул, дальше работает тик по расписанию.
import { dedup, names } from '@crm/core';
import { getDb, newId, type Sql } from '@/server/platform/db';
import type { Batch } from './envelope';
import { iinHmac, phoneHmac } from './hmac';
import { isAccepting } from './gate';
import {
  buildNormalizeCtx,
  holdRuleOf,
  normalizeItem,
  SourceUnknownError,
  type NormalizeCtx,
  type NormalizeResult,
  type Prepared,
} from './normalize';
import * as repo from './repo';
import { intakeSettings } from './settings';
import {
  emptyDropped,
  type BatchReport,
  type BriefReport,
  type DroppedFields,
  type FullCounts,
  type FullItem,
  type FullReport,
  type IngestPrincipal,
  type ItemStatus,
} from './types';

/** Приём закрыт: лицензия, выключатель или нет источника в настройках → 423 `not_accepting`. */
export class NotAcceptingError extends Error {
  override name = 'NotAcceptingError';
}

/** Тот же `batchId` с другим телом → 409 `idempotency_conflict`. */
export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
}

const emptyCounts = (received: number): FullCounts => ({
  received,
  created: 0,
  merged: 0,
  heldPair: 0,
  heldRule: 0,
  rejectedRule: 0,
  stopList: 0,
  noWorkingPhone: 0,
  invalid: 0,
});

const COUNT_KEY: Record<ItemStatus, keyof FullCounts> = {
  created: 'created',
  merged: 'merged',
  held_pair: 'heldPair',
  held_rule: 'heldRule',
  rejected_rule: 'rejectedRule',
  stop_list: 'stopList',
  no_working_phone: 'noWorkingPhone',
  invalid: 'invalid',
};

/** Для источника без `detailedReport`: только «принято» или «невалидно» (иначе ответ — оракул «номер есть в базе»). */
export function briefOf(r: FullReport): BriefReport {
  const invalid = r.counts.invalid;
  return {
    batchId: r.batchId,
    replayed: r.replayed,
    receivedAt: r.receivedAt,
    counts: { received: r.counts.received, accepted: r.counts.received - invalid, invalid },
    droppedFields: r.droppedFields,
    items: r.items.map((i) => ({
      index: i.index,
      externalId: i.externalId,
      status: i.status === 'invalid' ? 'invalid' : 'accepted',
      ...(i.code ? { code: i.code } : {}),
    })),
  };
}

/** Токены поиска клиента: название, номера и значения полей с `searchable`. */
function searchTokens(item: Prepared, ctx: NormalizeCtx, phones: readonly string[]): string[] {
  const out = [item.nameNorm, ...phones];
  for (const f of ctx.fields) {
    const v = item.custom[f.key];
    if (f.searchable && v !== undefined) out.push(Array.isArray(v) ? v.join(' ') : String(v));
  }
  return out.filter(Boolean);
}

/** Мобильные первыми: основной номер — первый после сортировки. */
const mobileFirst = <T extends { kind: string }>(phones: readonly T[]): T[] => [...phones].sort((a, b) => Number(b.kind === 'mobile') - Number(a.kind === 'mobile'));

interface Runner {
  sql: Sql;
  principal: IngestPrincipal;
  ctx: NormalizeCtx;
  index: dedup.CompanyIndex;
  /** externalId → клиент: из БД и созданные/дописанные в этой же партии. */
  ext: Map<string, string>;
  now: number;
}

/** Дописать пустые поля и новые номера; состояние карточки, владелец и итоги не меняются никогда. */
async function mergeInto(r: Runner, clientId: string, item: Prepared, phones: readonly Prepared['phones'][number][]): Promise<void> {
  const c = await repo.clientForMerge(r.sql, clientId);
  if (!c) throw new Error('клиент для дописывания не найден');
  const patch: repo.ClientPatch = {};
  if (!c.region && item.region) patch.region = item.region;
  if (!c.address && item.address) patch.address = item.address;
  if (!c.email && item.email) patch.email = item.email;
  if (!c.website && item.website) patch.website = item.website;
  if (!c.orgId && item.orgId) patch.orgId = item.orgId;
  if (c.iinHmac === null && item.iinHmac) patch.iinHmac = item.iinHmac;
  const newKeys = Object.keys(item.custom).filter((k) => !(k in c.custom));
  if (newKeys.length > 0) patch.custom = { ...c.custom, ...Object.fromEntries(newKeys.map((k) => [k, item.custom[k]])) };

  const fresh = mobileFirst(phones.filter((p) => !c.phones.includes(p.digits)));
  const tokens = [...fresh.map((p) => p.digits)];
  for (const f of r.ctx.fields) if (f.searchable && newKeys.includes(f.key)) tokens.push(String(item.custom[f.key]));
  if (tokens.length > 0 && (fresh.length > 0 || patch.custom)) patch.searchAppend = tokens.join(' ');
  if (Object.keys(patch).length > 0) await repo.patchClient(r.sql, clientId, patch, r.now);

  if (fresh.length > 0) {
    await repo.addPhones(
      r.sql,
      clientId,
      fresh.map((p, i) => ({ id: newId(), digits: p.digits, kind: p.kind, ext: p.ext, isPrimary: !c.hasPrimaryPhone && i === 0 })),
      r.now,
    );
    r.index.add({
      id: clientId,
      createdAt: c.createdAt,
      orgId: repo.orgKeyOf(c.orgId || item.orgId, c.iinHmac ?? item.iinHmac),
      phones: [...c.phones, ...fresh.map((p) => p.digits)],
      nameNorm: c.nameNorm,
      headNorm: item.headNorm,
    });
  }
  if (item.contactName && c.contactCount === 0) await repo.addContact(r.sql, newId(), clientId, item.contactName, r.now);
  // Запомнить externalId за клиентом: следующая партия узнает запись и без дедупа
  if (item.externalId && !r.ext.has(item.externalId)) {
    await repo.addSource(r.sql, { id: newId(), clientId, sourceKey: r.principal.sourceKey, keyId: r.principal.keyId, externalId: item.externalId, now: r.now });
    r.ext.set(item.externalId, clientId);
  }
}

async function createClient(
  r: Runner,
  item: Prepared,
  phones: readonly Prepared['phones'][number][],
  hold: { reason: '' | 'dup_pair' | 'rule'; code: string },
  pairs: readonly dedup.DupPair[],
): Promise<void> {
  const id = newId();
  const ordered = mobileFirst(phones);
  await repo.insertClient(r.sql, {
    id,
    kind: item.kind,
    name: item.name,
    nameNorm: item.nameNorm,
    legalForm: item.legalForm,
    orgId: item.orgId,
    iinHmac: item.iinHmac,
    region: item.region,
    address: item.address,
    email: item.email,
    website: item.website,
    custom: item.custom,
    searchNorm: searchTokens(item, r.ctx, ordered.map((p) => p.digits)).join(' '),
    sourceKey: r.principal.sourceKey,
    now: r.now,
  });
  await repo.addPhones(r.sql, id, ordered.map((p, i) => ({ id: newId(), digits: p.digits, kind: p.kind, ext: p.ext, isPrimary: i === 0 })), r.now);
  if (item.contactName) await repo.addContact(r.sql, newId(), id, item.contactName, r.now);
  await repo.addSource(r.sql, { id: newId(), clientId: id, sourceKey: r.principal.sourceKey, keyId: r.principal.keyId, externalId: item.externalId, now: r.now });
  await repo.insertCard(r.sql, { id: newId(), spaceId: r.principal.spaceId, clientId: id, holdReason: hold.reason, holdCode: hold.code, now: r.now });
  if (pairs.length > 0) await repo.insertPairs(r.sql, id, pairs.map((p) => ({ ...p, rowId: newId() })), r.now);
  r.index.add({
    id,
    createdAt: r.now,
    orgId: repo.orgKeyOf(item.orgId, item.iinHmac),
    phones: phones.map((p) => p.digits),
    nameNorm: item.nameNorm,
    headNorm: item.headNorm,
  });
  if (item.externalId) r.ext.set(item.externalId, id);
}

/** Партия целиком. Повтор с тем же телом возвращает сохранённый отчёт (`replayed: true`) без новых записей. */
export async function ingestBatch(principal: IngestPrincipal, batch: Batch, requestHash: string, now: number = Date.now()): Promise<BatchReport> {
  const { global } = await intakeSettings(principal);
  let ctx: NormalizeCtx;
  try {
    ctx = buildNormalizeCtx(global, principal.sourceKey, iinHmac);
  } catch (e) {
    if (e instanceof SourceUnknownError) throw new NotAcceptingError(e.message);
    throw e;
  }
  const accepting = await isAccepting();
  const db = await getDb();

  return db.tx(async (sql) => {
    await repo.lockIntake(sql);
    const prev = await repo.findBatch(sql, principal.sourceKey, batch.batchId);
    if (prev) {
      if (prev.requestHash !== requestHash) throw new IdempotencyConflictError('batchId уже использован с другим телом');
      return { ...prev.report, replayed: true };
    }
    if (!accepting) throw new NotAcceptingError('приём закрыт');

    const total = batch.items.length;
    const statuses: { status: ItemStatus; code?: FullItem['code'] }[] = new Array(total);
    const externalIds: (string | null)[] = batch.items.map((i) => (i.externalId?.trim() ? i.externalId.trim() : null));
    const dropped: DroppedFields = emptyDropped();

    // 1. Поля записи и правило отклонения
    const normalized: NormalizeResult[] = batch.items.map((raw) => normalizeItem(raw, ctx));
    const alive: { index: number; item: Prepared }[] = [];
    normalized.forEach((n, index) => {
      if (n.status === 'invalid') statuses[index] = { status: 'invalid', code: n.code };
      else if (n.status === 'rejected_rule') statuses[index] = { status: 'rejected_rule' };
      else alive.push({ index, item: n.item });
    });

    // 2. Стоп-лист: HMAC номеров считаем один раз на номер
    const hashOf = new Map<string, string>();
    const hash = (d: string): string => {
      let h = hashOf.get(d);
      if (!h) hashOf.set(d, (h = phoneHmac(d)));
      return h;
    };
    const hits = await repo.stopListHits(sql, [...new Set(alive.flatMap((a) => a.item.phones.map((p) => hash(p.digits))))]);
    const queue: { index: number; item: Prepared; phones: Prepared['phones'] }[] = [];
    for (const a of alive) {
      const verdict = dedup.applyStopList(a.item.phones.map((p) => p.digits), hash, hits);
      if (verdict.verdict === 'stop_list') statuses[a.index] = { status: 'stop_list' };
      else if (verdict.verdict === 'no_working_phone') statuses[a.index] = { status: 'no_working_phone' };
      else queue.push({ index: a.index, item: a.item, phones: a.item.phones.filter((p) => verdict.allowed.includes(p.digits)) });
    }

    // 3. Дедуп со всей базой: ключи партии → кандидаты из БД → индекс
    const known = await repo.loadKnownCompanies(
      sql,
      {
        orgKeys: queue.map((q) => repo.orgKeyOf(q.item.orgId, q.item.iinHmac)).filter((k): k is string => k !== null),
        phones: queue.flatMap((q) => q.phones.map((p) => p.digits)),
        nameNorms: queue.map((q) => q.item.nameNorm).filter(Boolean),
      },
      names.normalizePersonName,
    );
    // БИН/ИИН уникальны в БД (clients_org_uq, clients_iin_uq), поэтому совпадение по ним признаётся всегда
    const index = dedup.createCompanyIndex(known, { ...global.dedup, byOrgId: true });
    const ext = await repo.clientsByExternalId(sql, principal.sourceKey, queue.map((q) => q.item.externalId).filter((e): e is string => e !== null));
    const runner: Runner = { sql, principal, ctx, index, ext, now };

    // 4. По порядку записей: запись партии видна следующим записям этой же партии
    for (const q of queue) {
      let matchId = q.item.externalId ? (runner.ext.get(q.item.externalId) ?? null) : null;
      let pairs: readonly dedup.DupPair[] = [];
      if (!matchId) {
        const m = index.match({
          orgId: repo.orgKeyOf(q.item.orgId, q.item.iinHmac),
          phones: q.phones.map((p) => p.digits),
          nameNorm: q.item.nameNorm,
          headNorm: q.item.headNorm,
        });
        if (m.kind === 'duplicate') matchId = m.matchId;
        else if (m.kind === 'disputed') pairs = m.pairs;
      }
      if (matchId) {
        await mergeInto(runner, matchId, q.item, q.phones);
        statuses[q.index] = { status: 'merged' };
      } else if (pairs.length > 0) {
        await createClient(runner, q.item, q.phones, { reason: 'dup_pair', code: '' }, pairs);
        statuses[q.index] = { status: 'held_pair' };
      } else {
        const rule = holdRuleOf(q.item, ctx);
        await createClient(runner, q.item, q.phones, rule ? { reason: 'rule', code: rule } : { reason: '', code: '' }, []);
        statuses[q.index] = { status: rule ? 'held_rule' : 'created' };
      }
      for (const k of Object.keys(dropped) as (keyof DroppedFields)[]) dropped[k] += q.item.dropped[k];
    }

    // 5. Отчёт
    const counts = emptyCounts(total);
    const items: FullItem[] = statuses.map((s, index) => {
      counts[COUNT_KEY[s.status]]++;
      return { index, externalId: externalIds[index] ?? null, status: s.status, ...(s.code ? { code: s.code } : {}) };
    });
    const full: FullReport = {
      batchId: batch.batchId,
      replayed: false,
      receivedAt: now,
      counts,
      droppedFields: dropped,
      items,
      poolReady: await repo.poolReadyCount(sql, principal.spaceId),
    };
    const report: BatchReport = ctx.source.detailedReport ? full : briefOf(full);
    await repo.insertBatch(sql, { id: newId(), keyId: principal.keyId, sourceKey: principal.sourceKey, batchId: batch.batchId, requestHash, report, now });
    return report;
  });
}

