// Тонкая обёртка над правилами сделок (B6, rules.ts) для доски: чего не хватает для перехода на этап.
// Что обязательно, решает `stageRequirements`, пустоту поля — `isEmptyFieldValue`: тот же источник, что у
// `moveDealStage`, поэтому доска и сервер не расходятся. «Залежалась» — `staleDaysOf` из rules.ts.
import type { MissingCode } from './boardTypes';
import { isEmptyFieldValue, stageRequirements } from './rules';
import type { DealStageInfo } from './types';

/** Факты о сделке, из которых складывается «чего не хватает». */
export interface StageFacts {
  hasBooking: boolean;
  hasAttendance: boolean;
  /** Открытая задача со сроком у любого исполнителя или активная будущая запись (D-244). */
  hasNextStep: boolean;
  /** Поля сделки (`deals.custom`). */
  custom: Readonly<Record<string, unknown>> | null;
}

/**
 * Недостающее для этапа. Для `won` и `lost` не считается: у них свои формы (покупка, причина проигрыша).
 * Порядок кодов стабилен: запись, явка, следующий шаг, поля в порядке настроек. `hiddenFields` — ключи полей сделки,
 * скрытых роли зрителя.
 */
export function missingFor(stage: Pick<DealStageInfo, 'kind' | 'requires'>, facts: StageFacts, hiddenFields: ReadonlySet<string> = new Set()): MissingCode[] {
  if (stage.kind !== 'open') return [];
  const req = stageRequirements(stage);
  // Поле, скрытое роли: ни ключа, ни признака «заполнено» — как отказ сервера `stage_restricted` (D-323)
  if (req.fields.some((k) => hiddenFields.has(k))) return ['restricted'];
  const out: MissingCode[] = [];
  if (req.booking && !facts.hasBooking) out.push('booking');
  if (req.attendance && !facts.hasAttendance) out.push('attendance');
  if (req.nextTask && !facts.hasNextStep) out.push('next_step');
  for (const key of req.fields) if (isEmptyFieldValue(facts.custom?.[key])) out.push(`field:${key}`);
  return out;
}
