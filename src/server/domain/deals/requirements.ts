// Требования этапа при ручном переносе сделки (PROCESS 4.2, docs/deals-handoffs-design.md §5.7, D-301).
// Одна проверка на все пути переноса: POST /api/deals/[id]/stage и этап в итоге встречи консультанта (§4.9).
// Сделка уже заблокирована вызывающим в охвате `deal.edit`.
import type { Sql } from '@/server/platform/db';
import { DealDomainError } from './errors';
import { dealBookingFacts, hasOpenStepTask } from './repo.purchase';
import { isEmptyFieldValue, stageRequirements } from './rules';

export interface StageRequirementCheck {
  dealId: string;
  /** Поля сделки (`deals.custom`). */
  custom: Record<string, unknown> | null;
  /** Целевой этап; без `requires` — требований нет. */
  stage: Parameters<typeof stageRequirements>[0];
  /** Шаг с датой приходит в этом же действии (тело `nextStep` или шаг итога встречи). */
  hasNextStep: boolean;
}

/**
 * Бросает `next_step_required`, если этап требует шаг, а его нет ни в действии, ни открытой задачей со сроком по
 * сделке; `stage_fields_required` со списком незаполненных полей, записи (`booking`) и явки (`attendance`).
 */
export async function assertStageRequirements(tx: Sql, a: StageRequirementCheck): Promise<void> {
  const req = stageRequirements(a.stage);
  if (req.nextTask && !a.hasNextStep && !(await hasOpenStepTask(tx, a.dealId))) throw new DealDomainError('next_step_required');
  const missing = req.fields.filter((k) => isEmptyFieldValue(a.custom?.[k]));
  if (req.booking || req.attendance) {
    const facts = await dealBookingFacts(tx, a.dealId);
    if (req.booking && !facts.booking) missing.push('booking');
    if (req.attendance && !facts.attended) missing.push('attendance');
  }
  if (missing.length > 0) throw new DealDomainError('stage_fields_required', missing);
}
