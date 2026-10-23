// Применение импорта (дизайн C4d §7): одна транзакция под блокировкой импорта и блокировкой приёма;
// запись строго по пересчитанному предпросмотру с тем же отпечатком (D-113). Любая ошибка — откат целиком.
// Автор звонков, событий и выдач — РОП, нажавший «Применить» (assign_log.actor_id); звонок без сотрудника
// (user_id NULL, via='import', D-067). Побочные эффекты (задачи, стоп-лист) пишутся в той же транзакции.
import { dedup, fields, imports, time } from '@crm/core';
import { NotFoundError } from '@/server/access/errors';
import { getDb, newId } from '@/server/platform/db';
import type { Sql } from '@/server/platform/db/core';
import { blankCard, planImportedCard, type CardPlan } from './cardPlan';
import { customFromRow } from './customFields';
import { ImportError } from './errors';
import { computePreview, memoPhoneHmac, occurredAtOf, type Computation } from './load';
import { IMPORT_APPLY_LOCK_KEY, INTAKE_LOCK_KEY, iinHmac } from './platformGlue';
import { assertKind, assertOwners, blockersOf, configUnchanged, countHeldWorking, summaryOf } from './preview';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { ApplyCounts, ApplyRequest, ApplyResult, ImportActor, ImportReportV1 } from './types';

const HIDDEN = dedup.HIDDEN_ORG_ID_PREFIX;
const zeroCounts = (): ApplyCounts => ({
  clientsCreated: 0,
  clientsMerged: 0,
  cardsCreated: 0,
  cardsUpdated: 0,
  phonesAdded: 0,
  callsCreated: 0,
  pairsCreated: 0,
  tasksCreated: 0,
  stopListed: 0,
  keptInCrm: 0,
  skipped: 0,
  assigned: {},
});

type PhoneKind = 'mobile' | 'landline' | 'unknown';

interface Pending {
  clientId: string;
  client: repo.NewClientRow;
  phones: repo.NewPhoneRow[];
}

/** Номера строки, оставшиеся после стоп-листа, с видом номера; первый мобильный — основной. */
function phoneRowsOf(row: imports.ParsedRow, allowed: readonly string[], clientId: string, firstIsPrimary: boolean, notWorking: boolean): repo.NewPhoneRow[] {
  const kindOf = new Map<string, PhoneKind>(row.phones.flatMap((p) => (p.digits ? [[p.digits, p.kind as PhoneKind] as const] : [])));
  const primary = allowed.find((d) => kindOf.get(d) === 'mobile') ?? allowed[0];
  return allowed.map((d) => ({
    id: newId(),
    clientId,
    digits: d,
    kind: kindOf.get(d) ?? 'unknown',
    isWorking: !notWorking,
    isPrimary: firstIsPrimary && !notWorking && d === primary,
  }));
}

/** Запись по предпросмотру. Вызывается внутри транзакции, под блокировками. */
export async function writePreview(sql: Sql, ctx: ImportContext, actor: ImportActor, imp: repo.ImportRow, comp: Computation, now: number): Promise<ApplyCounts> {
  const counts = zeroCounts();
  const hash = memoPhoneHmac();
  const occurredAt = occurredAtOf(imp.report.input.snapshotDay, ctx.timeZone, now);
  const today = time.localDayOf(now, ctx.timeZone);
  const sourceKey = ctx.settings.sourceKey;
  const profile = comp.profile;

  const created = new Map<number, Pending>();
  const clientLinks: { rowNo: number; clientId: string }[] = [];
  const cards: repo.NewCardRow[] = [];
  const assigns: repo.NewAssignRow[] = [];
  const calls: repo.NewCallRow[] = [];
  const events: repo.NewEventRow[] = [];
  const pairs: repo.NewPairRow[] = [];
  const tasks: repo.NewTaskRow[] = [];
  const sources: repo.NewSourceRow[] = [];
  const extraPhones: repo.NewPhoneRow[] = [];
  /** Остановка номеров клиента «Полным отказом»: решает после вставки номеров, общий ли номер. */
  const stops: { clientId: string; importKey: string; digits: string[] }[] = [];

  // ----- состояние БД для слияний и правок -----
  const mergeTargets = new Set<string>();
  for (const pr of comp.preview.rows) {
    if (pr.action === 'merge' && pr.matchId && !pr.matchId.startsWith('row:')) mergeTargets.add(pr.matchId);
    if (pr.action === 'update_state' || pr.action === 'kept_in_crm') {
      const link = comp.priorLinks.get(comp.rowByNo.get(pr.rowNo)?.rowKey ?? '');
      if (link) mergeTargets.add(link.clientId);
    }
  }
  const targetIds = [...mergeTargets];
  const fillRows = new Map((await repo.selectClientsForFill(sql, targetIds)).map((c) => [c.id, c]));
  const cardRows = new Map((await repo.selectCards(sql, ctx.spaceId, targetIds)).map((c) => [c.clientId, c]));
  const phoneRows = new Map<string, repo.PhoneRow[]>();
  for (const p of await repo.selectPhones(sql, targetIds)) {
    const list = phoneRows.get(p.clientId) ?? [];
    list.push(p);
    phoneRows.set(p.clientId, list);
  }
  /** Что уже дописано слиянием в этом применении (повторное слияние в того же клиента). */
  const filled = new Map<string, { region: string; address: string; orgId: string; iinHmac: string | null; custom: Record<string, unknown>; phones: Set<string>; hasPrimary: boolean }>();
  const newCardFor = new Set<string>();

  const importKeyOf = (r: imports.ParsedRow) => imports.importKeyOf(r.rowKey, r.stateKey);
  const rowEvent = (clientId: string, r: imports.ParsedRow, action: string, extra: Record<string, unknown> = {}) =>
    events.push({
      id: newId(),
      clientId,
      kind: 'import.row',
      actorId: actor.userId,
      at: now,
      refType: 'import',
      refId: imp.id,
      // Только коды и служебные ключи: сырой текст ячеек (ответ, заметка) живёт лишь в import_rows до чистки по сроку (D-221)
      data: { importId: imp.id, rowNo: r.rowNo, rowKey: r.rowKey, stateKey: r.stateKey, action, outcomeKey: r.outcomeKey, ...extra },
    });
  const callEvent = (clientId: string, callId: string, p: NonNullable<CardPlan['call']>) =>
    events.push({ id: newId(), clientId, kind: 'call', actorId: null, at: p.occurredAt, refType: 'call', refId: callId, data: { outcome: p.outcomeCode, kind: p.outcomeKind, via: 'import' } });

  const planEffects = (clientId: string, cardId: string, owner: string | null, r: imports.ParsedRow, plan: CardPlan, allowedDigits: readonly string[]) => {
    const key = importKeyOf(r);
    if (plan.call) {
      const callId = newId();
      calls.push({
        id: callId,
        cardId,
        clientId,
        ownerAtCall: owner,
        outcomeCode: plan.call.outcomeCode,
        outcomeKind: plan.call.outcomeKind,
        lpr: plan.call.lpr,
        applied: plan.call.applied,
        factReason: plan.call.factReason,
        occurredAt: plan.call.occurredAt,
        importKey: key,
      });
      callEvent(clientId, callId, plan.call);
    }
    if (plan.effects.callbackTask) tasks.push({ id: newId(), clientId, kind: 'call', source: 'callback', assigneeUserId: owner, dueAt: now, sourceKey: `callback:${key}`, createdBy: actor.userId });
    if (plan.effects.clarifyTask) tasks.push({ id: newId(), clientId, kind: 'call', source: 'clarify_import', assigneeUserId: owner, dueAt: now, sourceKey: `clarify_import:${key}`, createdBy: actor.userId });
    if (plan.effects.stopListAllWorking && allowedDigits.length > 0) stops.push({ clientId, importKey: key, digits: [...allowedDigits] });
  };

  for (const pr of comp.preview.rows) {
    const row = comp.rowByNo.get(pr.rowNo);
    if (!row) continue;
    switch (pr.action) {
      case 'create': {
        const clientId = newId();
        const cardId = newId();
        const allowed = row.workingPhones.filter((d) => !comp.stopHits.has(hash(d)));
        const held = pr.hold !== '';
        const owner = !held && pr.ownerUserId ? pr.ownerUserId : null;
        const base = blankCard(cardId, clientId, owner, pr.hold);
        const plan = planImportedCard({
          card: base,
          row,
          held: held || owner === null,
          workingPhones: allowed.length,
          settings: ctx.calling,
          calendar: ctx.calendar,
          occurredAt,
          now,
          importKey: importKeyOf(row),
        });
        const clientCustom = customFromRow(row.fields, profile.fieldTargets, 'client', ctx.fieldDefs, ctx.phoneRules);
        const personalKey = row.orgIdPersonal && row.orgId ? (row.orgId.startsWith(HIDDEN) ? row.orgId : `${HIDDEN}${iinHmac(row.orgId)}`) : null;
        const client: repo.NewClientRow = {
          id: clientId,
          name: row.name,
          nameNorm: row.nameNorm,
          legalForm: ctx.legalKeyByCode.get(row.legalForm) ?? '',
          orgId: row.orgIdPersonal ? '' : (row.orgId ?? ''),
          iinHmac: personalKey ? personalKey.slice(HIDDEN.length) : null,
          region: row.region,
          address: row.fields.address ?? '',
          custom: clientCustom,
          searchNorm: '',
          sourceKey,
        };
        const phones = phoneRowsOf(row, allowed, clientId, true, plan.effects.singlePhoneNotWorking);
        created.set(row.rowNo, { clientId, client, phones });
        sources.push({ id: newId(), clientId, sourceKey, importId: imp.id, externalId: row.rowKey });
        const c = plan.card;
        const holdCode = pr.hold === 'rule' ? (dedup.evaluateRules(ctx.settings.rules.hold, { legalForm: row.legalForm, region: row.region })?.code ?? '') : '';
        cards.push({
          id: cardId,
          spaceId: ctx.spaceId,
          clientId,
          ownerUserId: c.ownerUserId,
          state: c.state,
          holdReason: c.holdReason,
          holdCode,
          attempts: c.attempts,
          nextCallAt: c.nextCallAt,
          returnAt: c.returnAt,
          lpr: c.lpr,
          isTarget: c.isTarget,
          lastOutcomeCode: c.lastOutcomeCode,
          lastOutcomeKind: c.lastOutcomeKind,
          lastOutcomeAt: c.lastOutcomeAt,
          closeReasonCode: c.closeReasonCode,
          closedAt: c.closedAt,
          assignedAt: owner ? now : null,
          callsTotal: c.callsTotal,
          connectsTotal: c.connectsTotal,
          noAnswerTotal: c.noAnswerTotal,
          firstConnectAt: c.firstConnectAt,
          lastConnectAt: c.lastConnectAt,
          lastTouchAt: c.lastTouchAt,
          custom: customFromRow(row.fields, profile.fieldTargets, 'card', ctx.fieldDefs, ctx.phoneRules),
        });
        if (owner) {
          assigns.push({ id: newId(), cardId, toUserId: owner, runId: imp.id, day: today, actorId: actor.userId });
          counts.assigned[owner] = (counts.assigned[owner] ?? 0) + 1;
        }
        events.push({ id: newId(), clientId, kind: 'client.created', actorId: actor.userId, at: now, refType: 'import', refId: imp.id, data: { sourceKind: 'import', importId: imp.id } });
        rowEvent(clientId, row, 'create', { deferred: plan.deferred, flags: plan.effects.flags, hold: pr.hold });
        planEffects(clientId, cardId, owner, row, plan, allowed);
        clientLinks.push({ rowNo: row.rowNo, clientId });
        counts.clientsCreated++;
        counts.cardsCreated++;
        break;
      }
      case 'merge': {
        const allowed = row.workingPhones.filter((d) => !comp.stopHits.has(hash(d)));
        const matchId = pr.matchId ?? '';
        if (matchId.startsWith('row:')) {
          // Строка выше в этом же файле создала клиента: дописываем в него до вставки
          const target = created.get(Number(matchId.slice(4)));
          if (!target) throw new Error('merge_target_missing');
          const have = new Set(target.phones.map((p) => p.digits));
          target.phones.push(...phoneRowsOf(row, allowed.filter((d) => !have.has(d)), target.clientId, target.phones.length === 0, false));
          if (target.client.region === '' && row.region) target.client.region = row.region;
          if (target.client.address === '' && row.fields.address) target.client.address = row.fields.address;
          const extra = customFromRow(row.fields, profile.fieldTargets, 'client', ctx.fieldDefs, ctx.phoneRules);
          for (const [k, v] of Object.entries(extra)) if (!(k in target.client.custom)) target.client.custom[k] = v;
          sources.push({ id: newId(), clientId: target.clientId, sourceKey, importId: imp.id, externalId: row.rowKey });
          rowEvent(target.clientId, row, 'merge');
          clientLinks.push({ rowNo: row.rowNo, clientId: target.clientId });
        } else {
          const fillRow = fillRows.get(matchId);
          if (!fillRow) throw new Error('merge_target_missing');
          let st = filled.get(matchId);
          if (!st) {
            const existing = phoneRows.get(matchId) ?? [];
            st = { region: fillRow.region, address: fillRow.address, orgId: fillRow.orgId, iinHmac: fillRow.iinHmac, custom: { ...fillRow.custom }, phones: new Set(existing.map((p) => p.digits)), hasPrimary: existing.some((p) => p.isPrimary) };
            filled.set(matchId, st);
          }
          const addDigits = allowed.filter((d) => !st.phones.has(d));
          const add = phoneRowsOf(row, addDigits, matchId, !st.hasPrimary, false);
          if (add.some((p) => p.isPrimary)) st.hasPrimary = true;
          for (const p of add) st.phones.add(p.digits);
          extraPhones.push(...add);
          const patch: { region: string | null; address: string | null; orgId: string | null; iinHmac: string | null; custom: Record<string, unknown> | null } = {
            region: !st.region && row.region ? row.region : null,
            address: !st.address && row.fields.address ? (row.fields.address as string) : null,
            orgId: !st.orgId && row.orgId && !row.orgIdPersonal ? row.orgId : null,
            iinHmac: !st.iinHmac && row.orgIdPersonal && row.orgId ? (row.orgId.startsWith(HIDDEN) ? row.orgId.slice(HIDDEN.length) : iinHmac(row.orgId)) : null,
            custom: null,
          };
          const extra = customFromRow(row.fields, profile.fieldTargets, 'client', ctx.fieldDefs, ctx.phoneRules);
          const newKeys = Object.keys(extra).filter((k) => !(k in st.custom));
          if (newKeys.length > 0) {
            for (const k of newKeys) st.custom[k] = extra[k];
            patch.custom = st.custom;
          }
          if (patch.region) st.region = patch.region;
          if (patch.address) st.address = patch.address;
          if (patch.orgId) st.orgId = patch.orgId;
          if (patch.iinHmac) st.iinHmac = patch.iinHmac;
          const append = [...addDigits, ...newKeys.map((k) => extra[k]).filter((v): v is string => typeof v === 'string')].join(' ');
          if (patch.region || patch.address || patch.orgId || patch.iinHmac || patch.custom || append) {
            await repo.fillClient(sql, matchId, { ...patch, searchAppend: append || null }, now);
          }
          sources.push({ id: newId(), clientId: matchId, sourceKey, importId: imp.id, externalId: row.rowKey });
          // Карточки в пространстве нет — создаётся «новая» без итога таблицы; есть — не меняется
          if (!cardRows.has(matchId) && !newCardFor.has(matchId)) {
            newCardFor.add(matchId);
            const blank = blankCard(newId(), matchId, null, '');
            cards.push({ ...blank, spaceId: ctx.spaceId, holdCode: '', custom: {}, assignedAt: null, lastOutcomeKind: '' });
            counts.cardsCreated++;
          }
          rowEvent(matchId, row, 'merge');
          clientLinks.push({ rowNo: row.rowNo, clientId: matchId });
        }
        counts.clientsMerged++;
        break;
      }
      case 'update_state': {
        const link = comp.priorLinks.get(row.rowKey);
        const card = link ? cardRows.get(link.clientId) : undefined;
        if (!link || !card) {
          counts.skipped++;
          break;
        }
        const existing = phoneRows.get(link.clientId) ?? [];
        const working = existing.filter((p) => p.isWorking);
        // Карточка без владельца и без задержки получает владельца строки, как при create (D-222): иначе
        // отложенный рабочий итог не применился бы и после настройки слотов
        const newOwner = card.ownerUserId === null && card.holdReason === '' && pr.ownerUserId ? pr.ownerUserId : null;
        const base = newOwner ? { ...card, ownerUserId: newOwner, assignedAt: now } : card;
        const plan = planImportedCard({
          // Поля цикла перезвона сервер пока не читает из БД (линия C2): импорт цикл не трогает.
          card: { ...base, phones: [], callbackReason: '', callbackTouches: 0, nextCallPrecision: 'time' },
          row,
          held: base.ownerUserId === null,
          workingPhones: working.length,
          settings: ctx.calling,
          calendar: ctx.calendar,
          occurredAt,
          now,
          importKey: importKeyOf(row),
        });
        clientLinks.push({ rowNo: row.rowNo, clientId: link.clientId });
        if (plan.deferred) {
          rowEvent(link.clientId, row, 'update_state', { deferred: true, flags: plan.effects.flags });
          break;
        }
        const c = plan.card;
        const ok = await repo.updateCardFromImport(
          sql,
          card.id,
          card.version,
          {
            ownerUserId: c.ownerUserId,
            assignedAt: c.assignedAt,
            state: c.state,
            holdReason: c.holdReason,
            attempts: c.attempts,
            nextCallAt: c.nextCallAt,
            returnAt: c.returnAt,
            lpr: c.lpr,
            isTarget: c.isTarget,
            lastOutcomeCode: c.lastOutcomeCode,
            lastOutcomeKind: c.lastOutcomeKind,
            lastOutcomeAt: c.lastOutcomeAt,
            closeReasonCode: c.closeReasonCode,
            closedAt: c.closedAt,
            callsTotal: c.callsTotal,
            connectsTotal: c.connectsTotal,
            noAnswerTotal: c.noAnswerTotal,
            firstConnectAt: c.firstConnectAt,
            lastConnectAt: c.lastConnectAt,
            lastTouchAt: c.lastTouchAt,
          },
          now,
        );
        if (!ok) {
          // оператор успел тронуть карточку между предпросмотром и записью
          counts.keptInCrm++;
          rowEvent(link.clientId, row, 'kept_in_crm');
          break;
        }
        counts.cardsUpdated++;
        if (newOwner) {
          assigns.push({ id: newId(), cardId: card.id, toUserId: newOwner, runId: imp.id, day: today, actorId: actor.userId });
          counts.assigned[newOwner] = (counts.assigned[newOwner] ?? 0) + 1;
        }
        if (plan.effects.closeTasks) await repo.closeTasks(sql, ctx.spaceId, link.clientId, plan.effects.closeTasks, now);
        if (plan.effects.singlePhoneNotWorking && working[0]) await repo.markPhoneNotWorking(sql, link.clientId, working[0].digits);
        planEffects(link.clientId, card.id, base.ownerUserId, row, plan, working.map((p) => p.digits));
        rowEvent(link.clientId, row, 'update_state', { flags: plan.effects.flags });
        break;
      }
      case 'kept_in_crm': {
        const link = comp.priorLinks.get(row.rowKey);
        if (link) {
          rowEvent(link.clientId, row, 'kept_in_crm');
          clientLinks.push({ rowNo: row.rowNo, clientId: link.clientId });
        }
        counts.keptInCrm++;
        break;
      }
      default:
        counts.skipped++;
    }
  }

  // ----- пары: идентификаторы `row:N` заменяются созданными клиентами -----
  for (const pr of comp.preview.rows) {
    if (pr.action !== 'create' || pr.pairs.length === 0) continue;
    const self = created.get(pr.rowNo);
    if (!self) continue;
    for (const p of pr.pairs) {
      const other = p.id.startsWith('row:') ? created.get(Number(p.id.slice(4)))?.clientId : p.id;
      if (other && other !== self.clientId) pairs.push({ id: newId(), a: self.clientId, b: other, reason: p.reason });
    }
  }

  // ----- запись пачками -----
  const pending = [...created.values()];
  for (const p of pending) {
    p.client.searchNorm = fields.buildSearchNorm({
      name: p.client.name,
      orgId: p.client.orgId,
      phones: p.phones.map((x) => x.digits),
      custom: p.client.custom as fields.CustomValues,
      searchable: ctx.searchable,
    });
  }
  await repo.insertClients(sql, pending.map((p) => p.client), now);
  const allPhones = [...pending.flatMap((p) => p.phones), ...extraPhones];
  await repo.insertPhones(sql, allPhones, now);
  counts.phonesAdded = allPhones.length;
  await repo.insertSources(sql, sources, now);
  await repo.insertCards(sql, cards, now);
  counts.callsCreated = await repo.insertCalls(sql, ctx.spaceId, calls, now, ctx.rev.space);
  await repo.insertAssignLog(sql, ctx.spaceId, assigns, now);
  await repo.insertEvents(sql, ctx.spaceId, events);
  counts.pairsCreated = await repo.insertPairs(sql, pairs, now);

  // Стоп-лист: номер, который есть у другого клиента (общий бухгалтер), без подтверждения РОП не блокируется (D-021)
  if (stops.length > 0) {
    const owners = await repo.selectDigitOwners(sql, [...new Set(stops.flatMap((s) => s.digits))]);
    const stopRows: { hmac: string; reason: string }[] = [];
    for (const s of stops) {
      for (const d of s.digits) {
        const others = [...(owners.get(d) ?? [])].filter((id) => id !== s.clientId);
        if (others.length > 0) {
          tasks.push({ id: newId(), clientId: s.clientId, kind: 'check', source: 'stoplist_confirm', assigneeUserId: null, dueAt: null, sourceKey: `stoplist_confirm:${s.importKey}:${d}`, createdBy: actor.userId });
        } else stopRows.push({ hmac: hash(d), reason: 'import_do_not_call' });
      }
    }
    counts.stopListed = await repo.insertStopList(sql, stopRows, actor.userId, now);
  }
  counts.tasksCreated = await repo.insertTasks(sql, ctx.spaceId, tasks, now);
  await repo.linkRowClients(sql, imp.id, clientLinks);
  return counts;
}

/** `POST /api/import/[id]/apply`. */
export async function applyImport(ctx: ImportContext, actor: ImportActor, importId: string, req: ApplyRequest, now: number): Promise<ApplyResult> {
  const db = await getDb();
  const started = Date.now();
  return db.tx(async (sql) => {
    await sql`SET LOCAL lock_timeout = '5s'`;
    await sql`SET LOCAL statement_timeout = '120s'`;
    // Один импорт на установку: второй РОП, двойное нажатие и ночная дозагрузка получают busy
    const [lock] = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${IMPORT_APPLY_LOCK_KEY}) AS ok`;
    if (!lock?.ok) throw new ImportError('busy');
    const imp = await repo.selectImport(sql, ctx.spaceId, importId, true);
    if (!imp) throw new NotFoundError();
    assertKind(ctx, imp, 'clients');
    if (imp.status === 'applied') {
      const prev = imp.report.apply;
      return { importId, alreadyApplied: true, appliedAt: imp.appliedAt ?? prev?.at ?? 0, written: prev && prev.kind !== 'bookings' ? prev.written : zeroCounts() };
    }
    if (imp.status === 'failed') throw new ImportError('blocked', { blockers: ['failed'] });
    if (!configUnchanged(imp.report, ctx)) throw new ImportError('blocked', { blockers: ['config_changed'] });
    // Приём, «Предложить контакт» и ручное создание ждут (D-022)
    await sql`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
    const stored = await repo.selectRows(sql, importId);
    if (stored.length === 0) throw new ImportError('rows_expired');
    const participants = await assertOwners(sql, ctx, req.ownerMap);
    const comp = await computePreview(sql, ctx, imp, stored, req.ownerMap);
    const blockers = blockersOf(imp, ctx, true, comp.preview.unmappedSlots.length);
    if (blockers.length > 0) throw new ImportError('blocked', { blockers });
    if (comp.fingerprint !== req.fingerprint) {
      throw new ImportError('preview_stale', { summary: summaryOf(imp, ctx, comp, participants, countHeldWorking(ctx, comp, imp, now), []) });
    }
    const written = await writePreview(sql, ctx, actor, imp, comp, now);
    const report: ImportReportV1 = { ...imp.report, apply: { at: now, by: actor.userId, fingerprint: comp.fingerprint, durationMs: Date.now() - started, written } };
    await repo.finishApply(sql, importId, now, report);
    await repo.insertAudit(sql, {
      id: newId(),
      actorId: actor.userId,
      spaceId: ctx.spaceId,
      action: 'import.apply',
      entityId: importId,
      meta: { importId, fingerprint: comp.fingerprint, written },
      now,
    });
    return { importId, alreadyApplied: false, appliedAt: now, written };
  });
}

