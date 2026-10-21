// Номера клиента: добавить с проверкой (D-126), «не работает», основной (5.2–5.3).
import { phone as phoneCore } from '@crm/core';
import { BadRequestError, type Viewer } from '@/server/access';
import { getDb, type Sql } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import { standPhoneRejected } from '@/server/platform/stand';
import { appendEvents } from '../timeline/repo';
import { loadClientsConfig } from './config';
import { toPhoneDto } from './dto';
import type { AddPhoneBody, PatchPhoneBody } from './input';
import {
  clearPrimary,
  contactBelongsToClient,
  countProbesToday,
  earliestWorkingPhone,
  insertPhone,
  insertProbe,
  insertReviewTask,
  isStopListed,
  lockClientForEdit,
  lockIntake,
  lockPhone,
  markPhoneNotWorking,
  phoneClientId,
  phoneTakenElsewhere,
  selectPhoneByDigits,
  selectPhoneById,
  selectPhones,
  setPrimary,
  throwNotFoundOrForbidden,
} from './repo';
import { refreshSearchNorm } from './searchNorm';
import type { PhoneDto } from './types';

export type AddPhoneResult = { status: 'added'; phone: PhoneDto } | { status: 'review' };

/**
 * Добавить номер клиенту. Порядок (D-126): общая блокировка приёма → блокировка клиента с охватом →
 * разбор номера → свой дубль → контакт → лимит проверок, стоп-лист, номер у другого клиента → либо
 * запись, либо задача РОП. Наружу «занят» и «стоп-лист» неотличимы: ответ один — `review`.
 * Блокировка приёма — первой, как у приёма (INTAKE_LOCK_KEY → строка клиента): при обратном порядке
 * партия, дописывающая этого клиента, и добавление номера ждали друг друга (40P01).
 */
export async function addPhone(viewer: Viewer, clientId: string, body: AddPhoneBody): Promise<AddPhoneResult> {
  const cfg = await loadClientsConfig(viewer);
  const db = await getDb();
  return db.tx(async (sql: Sql): Promise<AddPhoneResult> => {
    await lockIntake(sql);
    const client = await lockClientForEdit(sql, viewer, clientId);
    if (!client) return throwNotFoundOrForbidden(viewer, sql, 'client', clientId);

    const parsed = phoneCore.parsePhone(body.phone, cfg.phoneRules);
    if (!parsed || !parsed.working || !parsed.digits) throw new BadRequestError('phone_invalid');
    const digits = parsed.digits;
    // Стенд на Vercel (D-318): только служебные номера +7 709, настоящие на стенд не вводятся
    if (standPhoneRejected(digits)) throw new BadRequestError('stand_phone');

    // Свой номер: повтор безопасен, проверка номера не считается (это свой клиент)
    const own = await selectPhoneByDigits(sql, viewer, clientId, digits);
    if (own) return { status: 'added', phone: toPhoneDto(own) };

    const contactId = body.contactId ?? null;
    if (contactId !== null && !(await contactBelongsToClient(sql, viewer, contactId, clientId))) throw new BadRequestError('contact');

    const used = await countProbesToday(sql, viewer);
    const stopped = await isStopListed(sql, phoneHmac(digits));
    const taken = await phoneTakenElsewhere(sql, digits, clientId);
    await insertProbe(sql, viewer, taken || stopped);
    if (used >= cfg.probesPerDay || stopped || taken) {
      await insertReviewTask(sql, viewer, { clientId, opId: body.opId, title: `+${digits}` });
      return { status: 'review' };
    }

    const inserted = await insertPhone(sql, viewer, { id: body.opId, clientId, contactId, digits, ext: parsed.ext, kind: parsed.kind });
    const row = await selectPhoneById(sql, viewer, clientId, body.opId);
    // Повтор того же opId — тот же номер; чужой или другой номер с таким id — ошибка запроса
    if (!row || row.digits !== digits) throw new BadRequestError('op_id');
    if (inserted) {
      await appendEvents(sql, viewer, [{ clientId, kind: 'phone.added', refType: 'phone', refId: row.id, data: { phoneId: row.id } }]);
      await refreshSearchNorm(sql, viewer, clientId, cfg);
    }
    return { status: 'added', phone: toPhoneDto(row) };
  });
}

/** «Номер не работает» вручную или «сделать основным». Возвращает номера клиента. */
export async function updatePhone(viewer: Viewer, phoneId: string, body: PatchPhoneBody): Promise<PhoneDto[]> {
  const db = await getDb();
  return db.tx(async (sql: Sql): Promise<PhoneDto[]> => {
    // Блокировка приёма не нужна: путь не ждёт ничего, что держит приём, кроме строки клиента
    // (D-126). Клиент блокируется раньше номера — как в addPhone.
    const clientId = await phoneClientId(sql, viewer, phoneId);
    if (!clientId) return throwNotFoundOrForbidden(viewer, sql, 'client_phone', phoneId);
    const client = await lockClientForEdit(sql, viewer, clientId);
    if (!client) return throwNotFoundOrForbidden(viewer, sql, 'client', clientId);
    const row = await lockPhone(sql, viewer, phoneId, clientId);
    if (!row) return throwNotFoundOrForbidden(viewer, sql, 'client_phone', phoneId);

    if ('working' in body) {
      if (row.isWorking) {
        await markPhoneNotWorking(sql, viewer, phoneId);
        const events = [{ clientId, kind: 'phone.not_working', refType: 'phone', refId: phoneId, data: { phoneId } }];
        if (row.isPrimary) {
          const next = await earliestWorkingPhone(sql, viewer, clientId);
          if (next) {
            await setPrimary(sql, viewer, next);
            events.push({ clientId, kind: 'phone.primary', refType: 'phone', refId: next, data: { phoneId: next } });
          }
        }
        await appendEvents(sql, viewer, events);
      }
    } else {
      if (!row.isWorking) throw new BadRequestError('phone_not_working');
      if (!row.isPrimary) {
        await clearPrimary(sql, viewer, clientId);
        await setPrimary(sql, viewer, phoneId);
        await appendEvents(sql, viewer, [{ clientId, kind: 'phone.primary', refType: 'phone', refId: phoneId, data: { phoneId } }]);
      }
    }
    return (await selectPhones(sql, viewer, clientId)).map(toPhoneDto);
  });
}
