// Применение импорта «Записи» (D-324, docs/import-bookings-design.md §8): одна транзакция под блокировкой импорта
// и приёма, блокировки D-251 (карточки → мероприятия → записи клиентов) ДО пересчёта предпросмотра, запись строго
// по пересчитанному предпросмотру с тем же отпечатком (D-113). Запись пишет `createBooking` (места, сделка,
// история, лента), переход карточки — ядро (`import_agreed`) и `persistTransition`. Любая ошибка — откат целиком.
import { calling, type imports } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { bookingDeps, createBooking } from '@/server/domain/booking';
import { loadCallingContext, persistTransition } from '@/server/domain/cards';
import { lockCardScoped } from '@/server/domain/cards/repo';
import { getDb, newId } from '@/server/platform/db';
import type { Sql } from '@/server/platform/db/core';
import { computeBookingPreview, loadBookingInputs, bookingKeyOf, cleanAuthorMap } from './bookingLoad';
import { lockCovers, lockSetOf } from './bookingLocks';
import * as bookingRepo from './bookingRepo';
import { bookingBlockersOf, bookingProfileOf, bookingSummaryOf, bookingViewerOf } from './bookingSummary';
import { ImportError } from './errors';
import { occurredAtOf } from './load';
import { IMPORT_APPLY_LOCK_KEY, INTAKE_LOCK_KEY } from './platformGlue';
import { configUnchanged } from './preview';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { ApplyRequest, BookingApplyCounts, BookingApplyResult, ImportActor, ImportReportV1 } from './types';

const zeroCounts = (): BookingApplyCounts => ({ bookingsCreated: 0, cardsAgreed: 0, ownersAssigned: 0, authorChanged: 0, clarifyClosed: 0, skipped: 0 });

/** Каждый userId карты авторов — участник пространства (любой статус членства), иначе 400 bad_author. */
export async function assertAuthors(sql: Sql, ctx: ImportContext, authorMap: ApplyRequest['authorMap']): Promise<void> {
  const ids = [...new Set(Object.values(cleanAuthorMap(authorMap)).filter((v): v is string => v !== null))];
  const ok = await bookingRepo.selectMemberIds(sql, ctx.spaceId, ids);
  for (const id of ids) if (!ok.has(id)) throw new ImportError('bad_author');
}

/** Ошибка записи строки внутри транзакции: наружу уходит как `preview_stale` со свежей сводкой (откат целиком). */
class WriteFailure extends Error {
  constructor(readonly cause: unknown) {
    super('import.bookings: write failed');
  }
}

/** Запись по предпросмотру. Вызывается внутри транзакции, под блокировками. */
async function writeBookings(sql: Sql, ctx: ImportContext, viewer: Viewer, imp: repo.ImportRow, comp: Awaited<ReturnType<typeof computeBookingPreview>>, now: number): Promise<BookingApplyCounts> {
  const counts = zeroCounts();
  const keyOf = bookingKeyOf(ctx.spaceId);
  const callingCtx = await loadCallingContext(ctx.spaceId, now);
  const deps = { ...bookingDeps(), now: () => now };
  const occurredAt = occurredAtOf(imp.report.input.snapshotDay, ctx.timeZone, now);
  const agreedKey = ctx.agreedOutcomeKey;
  const openBefore = await bookingRepo.countOpenClarify(sql, ctx.spaceId);
  const events: repo.NewEventRow[] = [];
  const links: { rowNo: number; clientId: string }[] = [];

  for (const pr of comp.preview.rows) {
    const row = comp.rowByNo.get(pr.rowNo);
    if (!row) continue;
    if (pr.clientId) links.push({ rowNo: pr.rowNo, clientId: pr.clientId });
    if (pr.action === 'changed_in_file') {
      // Автор в таблице сменился: запись в CRM не меняется (заслуга после загрузки — данные CRM, D-042), пишется только
      // новое состояние строки, чтобы следующий повтор дал пропуск
      if (!pr.bookingId) throw new Error('changed_without_booking');
      await bookingRepo.insertImportHistory(sql, { id: newId(), bookingId: pr.bookingId, actorId: viewer.userId, meta: { importId: imp.id, rowNo: row.rowNo, stateKey: row.stateKey, changed: true }, at: now, fromStatus: '', toStatus: '' });
      counts.authorChanged++;
      continue;
    }
    if (pr.action !== 'create') {
      counts.skipped++;
      continue;
    }
    if (!pr.clientId || !pr.cardId || !pr.eventId) throw new Error('create_without_target');

    // 1. карточка без владельца получает автора записи (D-222): раньше записи, чтобы ответственным стал он
    if (pr.flags.includes('owner_from_author')) {
      const locked = await lockCardScoped(sql, viewer, pr.cardId, 'card.assign');
      if (!locked || !pr.ownerAfter) throw new NotFoundError();
      if (!(await bookingRepo.assignImportedOwner(viewer, sql, { cardId: pr.cardId, version: locked.snapshot.version, userId: pr.ownerAfter, now }))) throw new Error('owner_changed');
      await repo.insertAssignLog(sql, ctx.spaceId, [{ id: newId(), cardId: pr.cardId, toUserId: pr.ownerAfter, runId: imp.id, day: comp.today, actorId: viewer.userId }], now);
      counts.ownersAssigned++;
    }

    // 2. запись: одна семантика мест, сделки и истории с мастером записи
    const res = await createBooking(deps, viewer, { kind: 'group', requestId: newId(), clientId: pr.clientId, eventId: pr.eventId, contactId: null }, { tx: sql, imported: { importKey: keyOf(row), bookedByUserId: pr.authorUserId } });
    if (res.action !== 'created' || res.replayed) throw new Error('booking_not_created');
    counts.bookingsCreated++;

    // 3. прошлое состояние строки для повтора (D-048)
    await bookingRepo.insertImportHistory(sql, { id: newId(), bookingId: res.booking.id, actorId: viewer.userId, meta: { importId: imp.id, rowNo: row.rowNo, stateKey: row.stateKey }, at: now, fromStatus: '', toStatus: 'registered' });

    // 4. «Договорились» ядром: системное событие `import_agreed` с записью; выход из callback закрывает «Уточнить договорённость»
    if (pr.transition === 'to_agreed') {
      if (!agreedKey) throw new Error('no_agreed_outcome');
      const locked = await lockCardScoped(sql, viewer, pr.cardId, 'card.assign');
      if (!locked) throw new NotFoundError();
      const result = calling.applyOutcome({
        card: locked.snapshot,
        event: { type: 'import_agreed', opId: newId(), outcomeKey: agreedKey, occurredAt, bookingId: res.booking.id },
        actor: { userId: null, kind: 'system', scope: 'space' },
        now,
        settings: callingCtx.settings,
        calendar: callingCtx.calendar,
      });
      if (result.status !== 'applied') throw new Error(`import_agreed_${result.status}`);
      await persistTransition(sql, viewer, { ctx: callingCtx, before: locked, result, at: now });
      counts.cardsAgreed++;
    }

    // 5. лента клиента: только коды и ключи (D-221)
    events.push({
      id: newId(),
      clientId: pr.clientId,
      kind: 'import.row',
      actorId: viewer.userId,
      at: now,
      refType: 'import',
      refId: imp.id,
      data: { importId: imp.id, rowNo: row.rowNo, rowKey: row.rowKey, stateKey: row.stateKey, action: 'booking_created', bookingId: res.booking.id, flags: pr.flags },
    });
  }
  await repo.insertEvents(sql, ctx.spaceId, events);
  await repo.linkRowClients(sql, imp.id, links);
  counts.clarifyClosed = Math.max(0, openBefore - (await bookingRepo.countOpenClarify(sql, ctx.spaceId)));
  return counts;
}

/** `POST /api/import/[id]/apply` для профиля «Записи». */
export async function applyBookingImport(ctx: ImportContext, actor: ImportActor, importId: string, req: ApplyRequest, now: number): Promise<BookingApplyResult> {
  const viewer = bookingViewerOf(actor);
  const db = await getDb();
  const started = Date.now();
  try {
    return await db.tx(async (sql) => {
      await sql`SET LOCAL lock_timeout = '5s'`;
      await sql`SET LOCAL statement_timeout = '120s'`;
      // Один импорт на установку: второй РОП, двойное нажатие и ночная дозагрузка получают busy
      const [lock] = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${IMPORT_APPLY_LOCK_KEY}) AS ok`;
      if (!lock?.ok) throw new ImportError('busy');
      const imp = await repo.selectImport(sql, ctx.spaceId, importId, true);
      if (!imp) throw new NotFoundError();
      bookingProfileOf(ctx, imp.profileKey);
      if (imp.status === 'applied') {
        const prev = imp.report.apply;
        return { kind: 'bookings' as const, importId, alreadyApplied: true, appliedAt: imp.appliedAt ?? prev?.at ?? 0, written: prev?.kind === 'bookings' ? prev.written : zeroCounts() };
      }
      if (imp.status === 'failed') throw new ImportError('blocked', { blockers: ['failed'] });
      if (!configUnchanged(imp.report, ctx)) throw new ImportError('blocked', { blockers: ['config_changed'] });
      // Приём, «Предложить контакт» и ручное создание ждут: новый клиент не совпадёт со строкой посреди применения (D-022)
      await sql`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
      const stored = await repo.selectRows(sql, importId);
      if (stored.length === 0) throw new ImportError('rows_expired');
      await assertAuthors(sql, ctx, req.authorMap);

      // D-251: карточки (по id) → мероприятия (по id) → записи клиентов (по id), до пересчёта предпросмотра
      const rows = stored.map((r) => r.parsed as imports.ParsedBookingRow);
      const locked = lockSetOf(await loadBookingInputs(sql, ctx, viewer, rows));
      await bookingRepo.lockCardsOf(viewer, sql, { spaceId: ctx.spaceId, cardIds: locked.cardIds });
      await bookingRepo.lockEventsOf(viewer, sql, { spaceId: ctx.spaceId, eventIds: locked.eventIds });
      await bookingRepo.lockBookingsOfClients(viewer, sql, { spaceId: ctx.spaceId, clientIds: locked.clientIds });

      const comp = await computeBookingPreview(sql, ctx, viewer, imp, stored, req.authorMap, now);
      const blockers = bookingBlockersOf(imp, ctx, true, comp);
      if (blockers.length > 0) throw new ImportError('blocked', { blockers });
      // Пересчёт увидел незаблокированную карточку или мероприятие (появились после первого чтения): не пишем вне порядка D-251
      const stale = comp.fingerprint !== req.fingerprint || !lockCovers(locked, comp.inputs);
      if (stale) throw new ImportError('preview_stale', { summary: await bookingSummaryOf(sql, imp, ctx, comp, []) });

      let written: BookingApplyCounts;
      try {
        written = await writeBookings(sql, ctx, viewer, imp, comp, now);
      } catch (e) {
        throw new WriteFailure(e);
      }
      const report: ImportReportV1 = { ...imp.report, apply: { kind: 'bookings', at: now, by: actor.userId, fingerprint: comp.fingerprint, durationMs: Date.now() - started, written } };
      await repo.finishApply(sql, importId, now, report);
      await repo.insertAudit(sql, {
        id: newId(),
        actorId: actor.userId,
        spaceId: ctx.spaceId,
        action: 'import.apply',
        entityId: importId,
        meta: { importId, fingerprint: comp.fingerprint, kind: 'bookings', written },
        now,
      });
      return { kind: 'bookings' as const, importId, alreadyApplied: false, appliedAt: now, written };
    });
  } catch (e) {
    if (!(e instanceof WriteFailure)) throw e;
    // Под блокировками п. 8.2 сюда можно попасть только из-за ошибки в коде или гонки вне блокировок: всё откатилось,
    // РОП получает свежий предпросмотр и повторяет. В журнал — только код ошибки (в тексте бывают данные клиента).
    const code = e.cause instanceof Error ? e.cause.name : 'unknown';
    console.error(`import.bookings.apply_failed: ${code}`);
    throw new ImportError('preview_stale', { summary: await freshSummary(ctx, viewer, importId, req, now) });
  }
}

/** Свежий предпросмотр в отдельной читающей транзакции (после отката записи). */
async function freshSummary(ctx: ImportContext, viewer: Viewer, importId: string, req: ApplyRequest, now: number) {
  const db = await getDb();
  return db.tx(async (sql) => {
    const imp = await repo.selectImport(sql, ctx.spaceId, importId);
    if (!imp) throw new NotFoundError();
    const stored = await repo.selectRows(sql, importId);
    const comp = await computeBookingPreview(sql, ctx, viewer, imp, stored, req.authorMap, now);
    return bookingSummaryOf(sql, imp, ctx, comp, []);
  });
}
