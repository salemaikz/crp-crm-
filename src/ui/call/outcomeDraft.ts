// Черновик шторки при выборе итога (ui-polish §9.3, B4): чистая функция без React, чтобы правило проверяли юнит-тесты.
import { defaultDue } from './callbackPlan';
import type { CallConfig, OutcomeButton, SheetDraft } from './types';

/**
 * Что меняется в черновике, когда оператор выбрал итог `def`. Тот же итог повторно — ничего. Другой итог сбрасывает
 * причину и срок; у «Перезвонить» в воронке v2 срок сразу по касанию (подсказка), а не пустой.
 */
export function chooseDraftPatch(def: OutcomeButton, d: Pick<SheetDraft, 'outcomeKey' | 'phoneId'>, config: CallConfig, phones: readonly { id: string }[], touches: number | undefined, now: number): Partial<SheetDraft> | null {
  if (def.key === d.outcomeKey) return null;
  const due = config.callbackV2 && def.kind === 'callback' ? defaultDue({ steps: config.callbackSchedule, touches, now, tz: config.timeZone, cal: config.calendar, windowStart: config.callWindowStart }) : null;
  return {
    outcomeKey: def.key,
    reasonCode: '',
    callbackAt: due ? due.at : null,
    ...(config.callbackV2 ? { callbackPrecision: due ? due.precision : ('time' as const) } : {}),
    alsoDncPhoneIds: [],
    phoneId: d.phoneId ?? phones[0]?.id ?? null,
  };
}
