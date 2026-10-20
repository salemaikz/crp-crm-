// Формы данных экрана импорта. Клиентским компонентам нельзя импортировать src/server/**, поэтому типы
// берутся здесь (файл без 'use client' может ссылаться на домен только типами); page.tsx проверяет совместимость.
import type {
  ApplyBlocker,
  ApplyCounts,
  ApplyResult,
  ImportDetails,
  ImportListItem,
  ImportRowView,
  PreviewSummary,
  RowFilter,
  UploadResult,
} from '@/server/domain/import';

export type {
  ApplyBlocker,
  ApplyCounts,
  ApplyResult,
  ImportDetails,
  ImportListItem,
  ImportRowView,
  PreviewSummary,
  RowFilter,
  UploadResult,
};

export type ProfileOption = { key: string; label: string };

/** Фильтры списка строк в порядке выпадающего списка. */
export const ROW_FILTERS: readonly RowFilter[] = [
  'all',
  'create',
  'merge',
  'update_state',
  'kept_in_crm',
  'skip_same',
  'held',
  'dup_pair',
  'import_conflict',
  'no_working_phone',
  'unowned',
  'stop_list',
  'rejected_rule',
  'duplicate_in_file',
  'invalid',
  'need_review',
  'note_flag',
  'agreed_without_booking',
];
