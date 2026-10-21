// Требования этапа при ручном переносе сделки (PROCESS 4.2, docs/deals-handoffs-design.md §5.7, D-301).
// Одна проверка на все пути переноса: POST /api/deals/[id]/stage и этап в итоге встречи консультанта (§4.9).
// Сделка уже заблокирована вызывающим в охвате `deal.edit`. Поле, скрытое роли зрителя, в отказ не попадает и его
// значение исход не меняет (D-323): этап с таким полем этой роли закрыт всегда — `stage_restricted` без списка.
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
  /** Момент проверки: будущая запись считается шагом (D-244). */
  now: number;
  /** Ключи полей сделки, скрытых роли зрителя (`hiddenDealFieldKeys`). */
  hiddenFields: ReadonlySet<string>;
}

/**
 * Бросает `stage_restricted`, если этап требует поле, скрытое роли зрителя (до чтения значений: исход от них не
 * зависит); `next_step_required`, если этап требует шаг, а его нет ни в действии, ни открытой задачей со сроком по
 * сделке; `stage_fields_required` со списком незаполненных полей, записи (`booking`) и явки (`attendance`).
 */
export async function assertStageRequirements(tx: Sql, a: StageRequirementCheck): Promise<void> {
  const req = stageRequirements(a.stage);
  if (req.fields.some((k) => a.hiddenFields.has(k))) throw new DealDomainError('stage_restricted');
  if (req.nextTask && !a.hasNextStep && !(await hasOpenStepTask(tx, a.dealId, a.now))) throw new DealDomainError('next_step_required');
  const missing = req.fields.filter((k) => isEmptyFieldValue(a.custom?.[k]));
  if (req.booking || req.attendance) {
    const facts = await dealBookingFacts(tx, a.dealId);
    if (req.booking && !facts.booking) missing.push('booking');
    if (req.attendance && !facts.attended) missing.push('attendance');
  }
  if (missing.length > 0) throw new DealDomainError('stage_fields_required', missing);
}
