// Формы данных экрана импорта. Клиентским компонентам нельзя импортировать src/server/**, поэтому типы
// берутся здесь (файл без 'use client' может ссылаться на домен только типами); page.tsx проверяет совместимость.
import type {
  ApplyBlocker,
  ApplyCounts,
  ApplyResult,
  AuthorMapInput,
  BookingApplyCounts,
  BookingApplyResult,
  BookingAuthorHint,
  BookingDetails,
  BookingPreviewSummary,
  BookingRowView,
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
  AuthorMapInput,
  BookingApplyCounts,
  BookingApplyResult,
  BookingAuthorHint,
  BookingDetails,
  BookingPreviewSummary,
  BookingRowView,
  ImportDetails,
  ImportListItem,
  ImportRowView,
  PreviewSummary,
  RowFilter,
  UploadResult,
};

export type ProfileOption = { key: string; label: string; kind: 'clients' | 'bookings' };

/** Фильтры списка строк профиля «Записи» (D-324): группы отчёта и действия строки. */
export const BOOKING_ROW_FILTERS: readonly RowFilter[] = [
  'all',
  'create',
  'group_client_not_found',
  'group_no_event',
  'group_author_unknown',
  'group_duplicate',
  'group_review',
  'group_errors',
  'skip_same',
  'changed_in_file',
  'unsupported_type',
  'client_ambiguous',
  'past_event',
  'event_cancelled',
  'event_ambiguous',
  'duplicate_in_file',
  'booking_exists',
  'booking_conflict',
  'kept_in_crm',
  'state_conflict',
  'event_full',
  'invalid',
];

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
