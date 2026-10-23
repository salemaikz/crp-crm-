// Список всех писателей `cards` в src/server/** (pipeline-v2 §5.4). Ключ — «файл::функция» (ближайшее объявление
// верхнего уровня перед выражением). Новый UPDATE/INSERT без записи здесь роняет cards-writers.test.ts.
export type WriterCategory = 'persist' | 'custom-only' | 'owner-only' | 'hold-only' | 'insert-defaults' | 'insert-refreshed' | 'state-change' | 'derived-cache';

export interface WriterEntry {
  category: WriterCategory;
  /** Почему допустимо; для state-change — как сбрасывается цикл. */
  note: string;
  /** Для insert-refreshed: файлы вызывающих, обязанные пересчитать кэш после вставки. */
  refreshIn?: readonly string[];
}

const D = 'src/server/domain';

export const CARDS_WRITERS: Record<string, WriterEntry> = {
  [`${D}/cards/repo.ts::updateCardRow`]: { category: 'persist', note: 'все переходы ядра; цикл — в commit ядра; кэш пересчитывает persist (refreshCardDerived)' },
  [`${D}/cards/derivedRepo.ts::writeDerived`]: { category: 'derived-cache', note: 'кэш признаков и heat (§5.1): без version и updated_at, состояние не меняет' },
  [`${D}/cards/repo.ts::writeCardCustom`]: { category: 'custom-only', note: 'только custom' },
  [`${D}/cards/repo.ts::writeCardCustomBumped`]: { category: 'custom-only', note: 'только custom и версия' },
  [`${D}/distribution/repo.ts::writeAssignBatch`]: { category: 'owner-only', note: 'раздача из пула, только new: цикл уже сброшен' },
  [`${D}/distribution/repo.ts::writeInboundAssignment`]: { category: 'owner-only', note: 'владелец и touched_in_crm; состояние не меняется' },
  [`${D}/distribution/repo.ts::releaseActing`]: { category: 'owner-only', note: 'снять временного владельца' },
  [`${D}/team/transferRepo.ts::writeMoves`]: { category: 'owner-only', note: 'передача цикл не сбрасывает (§3.3)' },
  [`${D}/team/transferRepo.ts::replaceActing`]: { category: 'owner-only', note: 'временный владелец' },
  [`${D}/import/bookingRepo.ts::assignImportedOwner`]: { category: 'owner-only', note: 'только владелец' },
  [`${D}/import/repo.ts::insertCards`]: { category: 'insert-defaults', note: 'новая строка: цикл по умолчанию пуст (колонки не пишутся)' },
  [`${D}/import/repo.ts::updateCardFromImport`]: { category: 'state-change', note: 'сброс цикла по новому состоянию (W1); кэш пересчитывает apply.ts в той же транзакции' },
  [`${D}/intake/mergeRepo.ts::retireLoserCard`]: { category: 'state-change', note: 'возврат проигравшей в пул: цикл сброшен (W1); кэш пересчитывает merge.ts в той же транзакции' },
  [`${D}/intake/mergeRepo.ts::moveLoserCard`]: { category: 'owner-only', note: 'client_id; кэш пересчитывает merge.ts в той же транзакции' },
  [`${D}/intake/mergeRepo.ts::releaseDupPairHolds`]: { category: 'hold-only', note: 'только hold_reason' },
  [`${D}/intake/repo.ts::insertCard`]: {
    category: 'insert-refreshed',
    note: 'новая карточка: heat — вес состояния new и признаки клиента, значения по умолчанию неверны; кэш пересчитывает вызывающий в той же транзакции',
    refreshIn: [`${D}/intake/ingest.ts`, `${D}/intake/inbound.ts`, `${D}/intake/propose.ts`],
  },
  [`${D}/booking/repo.ts::insertWalkInCard`]: {
    category: 'insert-refreshed',
    note: 'карточка гостя: кэш пересчитывает walkIn.ts после записи явки в той же транзакции',
    refreshIn: [`${D}/booking/walkIn.ts`],
  },
};
