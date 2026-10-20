// Типы досок для клиентских файлов: форма данных задана доменом (B8), здесь только реэкспорт типов, потому что
// файлы с 'use client' не импортируют src/server/**. Рантайм-кода нет.
export type {
  BoardColumn,
  BoardFieldDef,
  BoardStage,
  CallingBoard,
  CallingColumn,
  CallingState,
  CallingTile,
  ClosedDeals,
  DealTile,
  DealsBoard,
  MissingCode,
} from '@/server/domain/deals/boardTypes';
