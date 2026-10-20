// Чистые правила доски сделок (B8): чего не хватает для перехода на этап и «залежалась». Без БД и Next.
// Источник обязательного — `requires` этапа из настроек (CONFIG §6.8). Те же поля читает `moveDealStage` (B6):
// после влития B6 `stageRequirements` и `staleDaysOf` живут в rules.ts, а этот файл остаётся обёрткой над ними.
import type { MissingCode } from './boardTypes';
import type { DealStageInfo } from './types';

/** Факты о сделке, из которых складывается «чего не хватает». */
export interface StageFacts {
  hasBooking: boolean;
  hasAttendance: boolean;
  /** Есть открытая задача со сроком по сделке (или будущая запись). */
  hasNextTask: boolean;
  /** Ключи заполненных полей сделки и клиента. */
  filled: ReadonlySet<string>;
}

const DAY_MS = 86_400_000;

/**
 * Недостающее для этапа. Для `won` и `lost` не считается: у них свои формы (покупка, причина проигрыша).
 * Порядок кодов стабилен: запись, явка, следующий шаг, поля в порядке настроек.
 */
export function missingFor(stage: Pick<DealStageInfo, 'kind' | 'requires'>, facts: StageFacts): MissingCode[] {
  if (stage.kind !== 'open') return [];
  const out: MissingCode[] = [];
  if (stage.requires.booking && !facts.hasBooking) out.push('booking');
  if (stage.requires.attendance && !facts.hasAttendance) out.push('attendance');
  if (stage.requires.nextTask && !facts.hasNextTask) out.push('next_step');
  for (const key of stage.requires.fields) if (!facts.filled.has(key)) out.push(`field:${key}`);
  return out;
}

/** «Залежалась» (D-244): календарные сутки на этапе не меньше `staleDays` → число суток, иначе null. */
export function staleDaysOf(deal: { status: 'open' | 'won' | 'lost'; stageChangedAt: number }, stage: Pick<DealStageInfo, 'staleDays'> | undefined, now: number): number | null {
  if (deal.status !== 'open' || !stage || stage.staleDays === null) return null;
  const days = Math.floor((now - deal.stageChangedAt) / DAY_MS);
  return days >= stage.staleDays ? days : null;
}

/** Порядок этапов для проверки «назад»: этап ниже текущего по `order`. */
export function isMoveBack(stages: readonly Pick<DealStageInfo, 'key' | 'order'>[], fromKey: string, toKey: string): boolean {
  const from = stages.find((s) => s.key === fromKey);
  const to = stages.find((s) => s.key === toKey);
  return !!from && !!to && to.order < from.order;
}
