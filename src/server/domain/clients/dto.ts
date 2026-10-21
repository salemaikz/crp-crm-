// Сборка DTO из строк БД: номера, контакты, ЛПР, проекция полей.
import { fields } from '@crm/core';
import type { CardHeadDb, ContactRowDb, PhoneRowDb } from './repo';
import type { CardHeadDto, CardState, ContactDto, PhoneDto } from './types';

export function toPhoneDto(r: PhoneRowDb): PhoneDto {
  return {
    id: r.id,
    e164: `+${r.digits}`,
    ext: r.ext,
    kind: r.kind,
    working: r.isWorking,
    primary: r.isPrimary,
    contactId: r.contactId,
    hasWhatsapp: r.hasWhatsapp,
  };
}

/** Главный номер: рабочий основной, иначе первый рабочий, иначе нет. */
export function pickPrimaryPhone(phones: readonly PhoneDto[]): PhoneDto | null {
  return phones.find((p) => p.working && p.primary) ?? phones.find((p) => p.working) ?? null;
}

export function toContactDto(r: ContactRowDb, fv: fields.FieldViewer, defs: readonly fields.FieldDef[]): ContactDto {
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    isDecisionMaker: r.isDecisionMaker,
    callHint: r.callHint,
    note: r.note,
    fields: fields.projectFor(fv, 'contact', defs, r.custom as fields.CustomValues),
  };
}

/** ЛПР — первый контакт с признаком (список уже упорядочен: ЛПР первыми). */
export function pickDecisionMaker(contacts: readonly ContactDto[]): { contactId: string; name: string } | null {
  const c = contacts.find((x) => x.isDecisionMaker);
  return c ? { contactId: c.id, name: c.name } : null;
}

export function toCardHead(r: CardHeadDb, cardFields: fields.Projection): CardHeadDto {
  return {
    id: r.id,
    state: r.state as CardState,
    holdReason: r.holdReason,
    nextCallAt: r.nextCallAt,
    attempts: r.attempts,
    lpr: r.lpr === 'yes' || r.lpr === 'no' ? r.lpr : '',
    isTarget: r.isTarget === 'yes' || r.isTarget === 'no' ? r.isTarget : '',
    lastOutcomeCode: r.lastOutcomeCode,
    ownerName: r.ownerName,
    actingName: r.actingName,
    version: r.version,
    ownerUserId: r.ownerUserId,
    actingUntilDay: r.actingUntilDay,
    closeReasonCode: r.closeReasonCode,
    closedAt: r.closedAt,
    returnAt: r.returnAt,
    fields: cardFields,
    counters: {
      callsTotal: r.callsTotal,
      noAnswerTotal: r.noAnswerTotal,
      connectsTotal: r.connectsTotal,
      firstConnectAt: r.firstConnectAt,
      lastConnectAt: r.lastConnectAt,
      lastTouchAt: r.lastTouchAt,
    },
  };
}
