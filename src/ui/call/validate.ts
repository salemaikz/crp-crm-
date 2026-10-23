// Проверка шторки итога на устройстве: те же правила, что в ядре обзвона (PROCESS 2.6, 3.2), чтобы кнопка
// «Сохранить» не оживала, пока чего-то не хватает. Решающая проверка — на сервере; код ошибки там тот же.
import type { SheetDraft, CallConfig, OutcomeButton, OutcomeRequest } from './types';

/** Виды, для которых действует `calling.lprRequiredOnContact` (зеркало ядра). */
const LPR_ON_CONTACT: readonly string[] = ['callback', 'agreed', 'not_interested'];

export type Missing = 'lpr' | 'lprInfo' | 'reason' | 'reasonText' | 'callbackAt' | 'phone' | 'field' | 'contact';

export function lprNeeded(def: OutcomeButton, cfg: Pick<CallConfig, 'lprRequiredOnContact'>): boolean {
  return def.requires.lpr || (cfg.lprRequiredOnContact && LPR_ON_CONTACT.includes(def.kind));
}

export function lprInfoFilled(d: SheetDraft): boolean {
  return [d.lprName, d.lprPhone, d.lprWhen].some((x) => x.trim() !== '');
}

/** Чего не хватает для итога. Пусто — можно сохранять. */
export function missingFor(
  def: OutcomeButton,
  d: SheetDraft,
  cfg: CallConfig,
  fieldValues: Record<string, string> = {},
  /** Есть ли у клиента контакт ЛПР: итогу с `requires.contact` без него отказывает ядро (`contact_required`). */
  hasContact = true,
): Missing[] {
  const out: Missing[] = [];
  if (def.requires.contact && !hasContact) out.push('contact');
  if (lprNeeded(def, cfg) && d.lpr === '') out.push('lpr');
  if (d.lpr === 'no' && cfg.lprNoRequiresInfo && !lprInfoFilled(d) && d.note.trim() === '') out.push('lprInfo');
  if (def.requires.reason) {
    if (d.reasonCode === '') out.push('reason');
    else if (def.reasons.find((r) => r.key === d.reasonCode)?.needsText && d.note.trim() === '') out.push('reasonText');
  }
  if ((def.kind === 'callback' || def.requires.callbackAt) && d.callbackAt === null) out.push('callbackAt');
  if ((def.kind === 'bad_number' || def.kind === 'do_not_call') && d.phoneId === null) out.push('phone');
  for (const k of def.requires.fields) if ((fieldValues[k] ?? '').trim() === '') out.push('field');
  return out;
}

/**
 * Итог можно поставить одним нажатием: ему ничего не нужно, кроме уже отмеченного. «Не берёт» — всегда;
 * «Номер не работает» и другие — когда причина, срок и номер не требуются или не нужны.
 */
export function oneTap(def: OutcomeButton, d: SheetDraft, cfg: CallConfig): boolean {
  if (def.kind === 'agreed') return false;
  if (def.kind === 'do_not_call' || def.kind === 'bad_number') return false;
  if (def.kind === 'callback') return false;
  if (def.requires.reason || def.requires.fields.length > 0) return false;
  return missingFor(def, d, cfg).length === 0;
}

export function buildRequest(args: {
  opId: string;
  cardId: string;
  def: OutcomeButton;
  draft: SheetDraft;
  tappedAt: number | null;
  now: number;
  online: boolean;
  fieldValues?: Record<string, string>;
  agreement?: OutcomeRequest['agreement'];
  /** `CALLBACK_V2`: перезвон уходит с `callbackPrecision` — это и есть признак нового контракта (§4.4). */
  callbackV2?: boolean;
}): OutcomeRequest {
  const { def, draft: d } = args;
  const info = lprInfoFilled(d) ? { name: d.lprName.trim(), phone: d.lprPhone.trim(), when: d.lprWhen.trim() } : null;
  const fields: Record<string, unknown> = {};
  for (const k of def.requires.fields) fields[k] = (args.fieldValues?.[k] ?? '').trim();
  return {
    opId: args.opId,
    cardId: args.cardId,
    outcomeKey: def.key,
    via: args.online ? 'ui' : 'offline',
    occurredAt: args.now,
    tappedAt: args.tappedAt,
    phoneId: d.phoneId,
    reasonCode: d.reasonCode,
    note: d.note.trim().slice(0, 2000),
    lpr: d.lpr,
    lprInfo: d.lpr === 'no' ? info : null,
    callbackAt: def.kind === 'callback' || def.requires.callbackAt ? d.callbackAt : null,
    markTarget: d.target,
    alsoDncPhoneIds: def.kind === 'do_not_call' ? d.alsoDncPhoneIds.filter((id) => id !== d.phoneId) : [],
    fields,
    durationSec: null,
    agreement: args.agreement ?? null,
    ...((args.callbackV2 === true || d.callbackPrecision !== undefined) && def.kind === 'callback' ? { callbackPrecision: d.callbackPrecision ?? 'time' } : {}),
  };
}
