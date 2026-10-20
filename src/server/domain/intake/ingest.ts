// Приём партии лидов (INTEGRATIONS 5.2): одна транзакция под общей блокировкой приёма.
// Порядок для каждой записи — как у импорта (PROCESS 2.3): поля → правило отклонения → стоп-лист → дедуп → правило
// задержки → создание. Раздачи при приёме нет (PROCESS 7.2): карточки ложатся в пул, дальше работает тик по расписанию.
import { dedup, fields, names } from '@crm/core';
import { getDb, isUniqueViolation, newId, type Db, type Sql } from '@/server/platform/db';
import { clientSearchableKeys } from '../clients/config';
import type { Batch } from './envelope';
import { iinHmac, phoneHmac } from '@/server/platform/hmac';
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

/** Строка поиска клиента — та же функция, что у правки в карточке (D-123): свёртка, БИН, номера, поля, видимые всем. */
function searchNormOf(ctx: NormalizeCtx, v: { name: string; orgId: string; phones: readonly string[]; custom: Record<string, unknown> }): string {
  return fields.buildSearchNorm({ name: v.name, orgId: v.orgId, phones: v.phones, custom: v.custom as fields.CustomValues, searchable: ctx.searchable });
}

/** Мобильные первыми: основной номер — первый после сортировки. */
const mobileFirst = <T extends { kind: string }>(phones: readonly T[]): T[] => [...phones].sort((a, b) => Number(b.kind === 'mobile') - Number(a.kind === 'mobile'));

/**
 * Ключи номера записи для индекса (D-141, D-142): открытый БИН — с псевдонимом `iin:<HMAC>`; ИИН — только
 * `iin:<HMAC>` с признаком неуверенности; форма собственности — чтобы «ТОО Альфа» и «ИП Альфа» были парой.
 */
function itemKeys(item: Prepared, ctx: NormalizeCtx): Pick<dedup.CompanyKeys, 'orgId' | 'orgIdAliases' | 'orgIdUncertain' | 'legalForm'> {
  const stored = repo.storedOrgKeys(item, ctx.iinHmac);
  return { ...stored, orgIdUncertain: !item.orgId && item.orgIdUncertain, legalForm: item.legalForm };
}

interface Runner {
  db: Db;
  principal: IngestPrincipal;
  ctx: NormalizeCtx;
  index: dedup.CompanyIndex;
  /** externalId → клиент: из БД и созданные/дописанные в этой же партии. */
  ext: Map<string, string>;
  now: number;
}

/** Что записанная запись меняет в памяти партии: индекс дедупа и externalId. Применяется после успешной записи. */
interface Written {
  known: dedup.KnownCompany | null;
  externalId: string | null;
  clientId: string;
}

/** Дописать пустые поля и новые номера; состояние карточки, владелец и итоги не меняются никогда. */
async function mergeInto(r: Runner, sql: Sql, clientId: string, item: Prepared, phones: readonly Prepared['phones'][number][]): Promise<Written> {
  const c = await repo.clientForMerge(sql, clientId);
  if (!c) throw new Error('клиент для дописывания не найден');
  const patch: repo.ClientPatch = {};
  if (!c.region && item.region) patch.region = item.region;
  if (!c.address && item.address) patch.address = item.address;
  if (!c.email && item.email) patch.email = item.email;
  if (!c.website && item.website) patch.website = item.website;
  // БИН — не клиенту с формой ИП и не физлицу (D-052, D-181): склейка по externalId проходит мимо дедупа
  if (!c.orgId && item.orgId && fields.orgIdNature(c.legalForm, c.kind, r.ctx.legalForms) !== 'personal') patch.orgId = item.orgId;
  // Номер, скрытый «по неуверенности», у клиента с открытым БИН — скорее всего тот же БИН: второй раз не храним (D-141)
  if (c.iinHmac === null && item.iinHmac && !(item.orgIdUncertain && c.orgId)) patch.iinHmac = item.iinHmac;
  const newKeys = Object.keys(item.custom).filter((k) => !(k in c.custom));
  if (newKeys.length > 0) patch.custom = { ...c.custom, ...Object.fromEntries(newKeys.map((k) => [k, item.custom[k]])) };

  const fresh = mobileFirst(phones.filter((p) => !c.phones.includes(p.digits)));
  const changed = Object.keys(patch).length > 0 || fresh.length > 0;
  let stored = { orgId: c.orgId, iinHmac: c.iinHmac };
  if (Object.keys(patch).length > 0) stored = await repo.patchClient(sql, clientId, patch, r.now);

  if (fresh.length > 0) {
    await repo.addPhones(
      sql,
      clientId,
      fresh.map((p, i) => ({ id: newId(), digits: p.digits, kind: p.kind, ext: p.ext, isPrimary: !c.hasPrimaryPhone && i === 0 })),
      r.now,
    );
  }
  if (changed) {
    const src = await repo.searchSource(sql, clientId);
    if (src) await repo.setSearchNorm(sql, clientId, searchNormOf(r.ctx, src));
  }
  if (item.contactName && c.contactCount === 0) await repo.addContact(sql, newId(), clientId, item.contactName, r.now);
  // Запомнить externalId за клиентом: следующая партия узнает запись и без дедупа
  const rememberExt = item.externalId && !r.ext.has(item.externalId) ? item.externalId : null;
  if (rememberExt) await repo.addSource(sql, { id: newId(), clientId, sourceKey: r.principal.sourceKey, keyId: r.principal.keyId, externalId: rememberExt, now: r.now });
  return {
    clientId,
    externalId: rememberExt,
    known: changed
      ? {
          id: clientId,
          createdAt: c.createdAt,
          ...repo.storedOrgKeys(stored, r.ctx.iinHmac),
          legalForm: c.legalForm,
          phones: [...c.phones, ...fresh.map((p) => p.digits)],
          nameNorm: c.nameNorm,
          headNorm: item.headNorm,
        }
      : null,
  };
}

async function createClient(
  r: Runner,
  sql: Sql,
  item: Prepared,
  phones: readonly Prepared['phones'][number][],
  hold: { reason: '' | 'dup_pair' | 'rule'; code: string },
  pairs: readonly dedup.DupPair[],
): Promise<Written> {
  // БИН и ИИН уникальны. Занятый другим клиентом (ИИН у ИП, а запись — ТОО с тем же ИИН; БИН обезличенного)
  // не роняет партию: клиент создаётся без этого номера, номер считается отброшенным (D-182).
  const taken = await repo.orgKeysTaken(sql, item.orgId, item.iinHmac);
  if (taken.org) {
    item.orgId = '';
    item.dropped.orgId++;
  }
  if (taken.iin) {
    if (item.iinFrom === 'orgId') item.dropped.orgId++;
    else item.dropped.iin++;
    item.iinHmac = null;
    item.iinFrom = null;
    item.orgIdUncertain = false;
  }
  const id = newId();
  const ordered = mobileFirst(phones);
  await repo.insertClient(sql, {
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
    searchNorm: searchNormOf(r.ctx, { name: item.name, orgId: item.orgId, phones: ordered.map((p) => p.digits), custom: item.custom }),
    sourceKey: r.principal.sourceKey,
    now: r.now,
  });
  await repo.addPhones(sql, id, ordered.map((p, i) => ({ id: newId(), digits: p.digits, kind: p.kind, ext: p.ext, isPrimary: i === 0 })), r.now);
  if (item.contactName) await repo.addContact(sql, newId(), id, item.contactName, r.now);
  await repo.addSource(sql, { id: newId(), clientId: id, sourceKey: r.principal.sourceKey, keyId: r.principal.keyId, externalId: item.externalId, now: r.now });
  await repo.insertCard(sql, { id: newId(), spaceId: r.principal.spaceId, clientId: id, holdReason: hold.reason, holdCode: hold.code, now: r.now });
  if (pairs.length > 0) await repo.insertPairs(sql, id, pairs.map((p) => ({ ...p, rowId: newId() })), r.now);
  return {
    clientId: id,
    externalId: item.externalId,
    known: {
      id,
      createdAt: r.now,
      ...repo.storedOrgKeys(item, r.ctx.iinHmac),
      legalForm: item.legalForm,
      phones: phones.map((p) => p.digits),
      nameNorm: item.nameNorm,
      headNorm: item.headNorm,
    },
  };
}

/**
 * Запись одной записи партии в своей точке сохранения: ошибка уникальности откатывает только её (D-182).
 * Повтор — без БИН и ИИН (их конфликт — единственный ожидаемый); другая ошибка роняет партию, как раньше.
 */
async function writeItem(r: Runner, write: (sql: Sql) => Promise<Written>, item: Prepared): Promise<Written> {
  try {
    return await r.db.tx(write);
  } catch (e) {
    if (!isUniqueViolation(e) || (!item.orgId && !item.iinHmac)) throw e;
    if (item.orgId) item.dropped.orgId++;
    if (item.iinHmac) item.dropped[item.iinFrom === 'iin' ? 'iin' : 'orgId']++;
    item.orgId = '';
    item.iinHmac = null;
    item.iinFrom = null;
    item.orgIdUncertain = false;
    return r.db.tx(write);
  }
}

/** Партия целиком. Повтор с тем же телом возвращает сохранённый отчёт (`replayed: true`) без новых записей. */
export async function ingestBatch(principal: IngestPrincipal, batch: Batch, requestHash: string, now: number = Date.now()): Promise<BatchReport> {
  const { global, space } = await intakeSettings(principal);
  let ctx: NormalizeCtx;
  try {
    ctx = buildNormalizeCtx(global, principal.sourceKey, iinHmac, clientSearchableKeys(global, space));
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

    // 3. Дедуп со всей базой: ключи партии → кандидаты из БД → индекс. Кандидаты ищутся по всем ключам номера:
    //    БИН, HMAC ИИН, HMAC открытого БИН (клиент, скрытый «по неуверенности») и открытый БИН для неуверенного
    //    номера (D-141, D-182).
    const known = await repo.loadKnownCompanies(
      sql,
      {
        bins: queue.flatMap((q) => [q.item.orgId, q.item.binProbe].filter(Boolean)),
        iinHmacs: queue.flatMap((q) => [q.item.iinHmac ?? '', q.item.orgId ? ctx.iinHmac(q.item.orgId) : ''].filter(Boolean)),
        phones: queue.flatMap((q) => q.phones.map((p) => p.digits)),
        nameNorms: queue.map((q) => q.item.nameNorm).filter(Boolean),
      },
      names.normalizePersonName,
      ctx.iinHmac,
    );
    // Неуверенный номер больше не нужен открытым: дальше он сравнивается только как HMAC
    for (const q of queue) q.item.binProbe = '';
    // БИН/ИИН уникальны в БД (clients_org_uq, clients_iin_uq), поэтому совпадение по ним признаётся всегда
    const index = dedup.createCompanyIndex(known, { ...global.dedup, byOrgId: true });
    const ext = await repo.clientsByExternalId(sql, principal.sourceKey, queue.map((q) => q.item.externalId).filter((e): e is string => e !== null));
    const runner: Runner = { db, principal, ctx, index, ext, now };

    // 4. По порядку записей: запись партии видна следующим записям этой же партии
    for (const q of queue) {
      let matchId = q.item.externalId ? (runner.ext.get(q.item.externalId) ?? null) : null;
      let pairs: readonly dedup.DupPair[] = [];
      if (!matchId) {
        const m = index.match({
          ...itemKeys(q.item, ctx),
          phones: q.phones.map((p) => p.digits),
          nameNorm: q.item.nameNorm,
          headNorm: q.item.headNorm,
        });
        if (m.kind === 'duplicate') matchId = m.matchId;
        else if (m.kind === 'disputed') pairs = m.pairs;
      }
      let written: Written;
      if (matchId) {
        const target = matchId;
        written = await writeItem(runner, (s) => mergeInto(runner, s, target, q.item, q.phones), q.item);
        statuses[q.index] = { status: 'merged' };
      } else if (pairs.length > 0) {
        written = await writeItem(runner, (s) => createClient(runner, s, q.item, q.phones, { reason: 'dup_pair', code: '' }, pairs), q.item);
        statuses[q.index] = { status: 'held_pair' };
      } else {
        const rule = holdRuleOf(q.item, ctx);
        written = await writeItem(runner, (s) => createClient(runner, s, q.item, q.phones, rule ? { reason: 'rule', code: rule } : { reason: '', code: '' }, []), q.item);
        statuses[q.index] = { status: rule ? 'held_rule' : 'created' };
      }
      if (written.known) index.add(written.known);
      if (written.externalId) runner.ext.set(written.externalId, written.clientId);
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

