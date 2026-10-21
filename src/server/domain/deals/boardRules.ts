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
 * Порядок кодов стабилен: запись, явка, следующий шаг, поля в порядке настроек.
 */
export function missingFor(stage: Pick<DealStageInfo, 'kind' | 'requires'>, facts: StageFacts): MissingCode[] {
  if (stage.kind !== 'open') return [];
  const req = stageRequirements(stage);
  const out: MissingCode[] = [];
  if (req.booking && !facts.hasBooking) out.push('booking');
  if (req.attendance && !facts.hasAttendance) out.push('attendance');
  if (req.nextTask && !facts.hasNextStep) out.push('next_step');
  for (const key of req.fields) if (isEmptyFieldValue(facts.custom?.[key])) out.push(`field:${key}`);
  return out;
}
