// Ошибки импорта: код без текста (текст — messages/ru/import.json). В лог и аудит — только код.
import type { PreviewSummary, ApplyBlocker, ImportErrorCode } from './types';

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    readonly detail: { missing?: readonly string[]; summary?: PreviewSummary; blockers?: readonly ApplyBlocker[] } = {},
  ) {
    super(`import: ${code}`);
    this.name = 'ImportError';
  }
}
