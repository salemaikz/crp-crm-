// Ошибки импорта: код без текста (текст — messages/ru/import.json). В лог и аудит — только код.
import type { PreviewSummary, BookingPreviewSummary, ApplyBlocker, ImportErrorCode } from './types';

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    readonly detail: { missing?: readonly string[]; summary?: PreviewSummary | BookingPreviewSummary; blockers?: readonly ApplyBlocker[] } = {},
  ) {
    super(`import: ${code}`);
    this.name = 'ImportError';
  }
}
