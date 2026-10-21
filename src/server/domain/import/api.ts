// Вход для маршрутов и страниц импорта (ImportApi): по виду профиля загрузки отдаёт вызов сервису таблиц клиентов
// (service.ts) или профилю «Записи» (bookingService.ts, bookingApply.ts). Вид берётся из профиля загрузки, а не из тела
// запроса: чужая или несуществующая загрузка — 404 в обоих сервисах (D-017).
import { getDb } from '@/server/platform/db';
import { applyBookingImport } from './bookingApply';
import { bookingImportService } from './bookingService';
import { importService } from './service';
import * as repo from './repo';
import { loadImportContext } from './settings';
import type { ImportActor, ImportApi } from './types';

/** Вид профиля загрузки; загрузки нет — 'clients' (сервис ответит 404). */
async function kindOf(actor: ImportActor, importId: string): Promise<'clients' | 'bookings'> {
  const db = await getDb();
  const imp = await repo.selectImport(db.sql, actor.spaceId, importId);
  if (!imp) return 'clients';
  const ctx = await loadImportContext(actor.spaceId);
  return ctx.settings.profiles.find((p) => p.key === imp.profileKey)?.kind ?? 'clients';
}

export const importApi: ImportApi = {
  listImports: (actor, limit) => importService.listImports(actor, limit),
  getImport: (actor, id, now) => importService.getImport(actor, id, now),
  upload: (actor, input, now) => importService.upload(actor, input, now),

  async preview(actor, id, req, now) {
    return (await kindOf(actor, id)) === 'bookings' ? bookingImportService.preview(actor, id, req, now) : importService.preview(actor, id, req, now);
  },

  async listRows(actor, id, q, now) {
    return (await kindOf(actor, id)) === 'bookings' ? bookingImportService.listRows(actor, id, q, now) : importService.listRows(actor, id, q, now);
  },

  async exportRowsCsv(actor, id, filter, now, headers = {}) {
    return (await kindOf(actor, id)) === 'bookings'
      ? bookingImportService.exportRowsCsv(actor, id, filter, now, headers.bookings)
      : importService.exportRowsCsv(actor, id, filter, now, headers.clients);
  },

  async apply(actor, id, req, now) {
    if ((await kindOf(actor, id)) !== 'bookings') return importService.apply(actor, id, req, now);
    const ctx = await loadImportContext(actor.spaceId);
    return applyBookingImport(ctx, actor, id, req, now);
  },
};
