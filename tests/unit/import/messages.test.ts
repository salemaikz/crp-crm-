// Тексты импорта: у каждого кода ошибки, блокера, действия и фильтра есть строка в messages/ru/import.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ROW_FILTERS } from '../../../src/app/(mgr)/import/types';
import type { SpreadsheetErrorCode } from '../../../src/server/platform/files';
import type { ApplyBlocker, ImportErrorCode } from '../../../src/server/domain/import';

const msg = JSON.parse(readFileSync('messages/ru/import.json', 'utf8')) as Record<string, Record<string, unknown>>;
const keys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.keys(o) : []);

test('коды ошибок файла и импорта имеют текст', () => {
  const files: SpreadsheetErrorCode[] = ['too_large', 'empty', 'bad_type', 'legacy_xls', 'macro', 'corrupt', 'zip_limits', 'xml_doctype', 'unsupported_encoding', 'sheet_required', 'sheet_not_found', 'too_many_rows', 'busy'];
  const imp: ImportErrorCode[] = ['not_found', 'feature_off', 'busy', 'preview_stale', 'blocked', 'rows_expired', 'bad_owner', 'bad_profile', 'header_not_found'];
  const have = new Set(keys(msg.errors));
  for (const c of [...files, ...imp, 'generic', 'network', 'rate_limited']) {
    if (c === 'feature_off') continue; // выключенный модуль отдаётся как 404
    assert.ok(have.has(c), `errors.${c}`);
  }
});

test('блокеры, статусы, действия строк и фильтры имеют текст', () => {
  const blockers: ApplyBlocker[] = ['unmapped_slots', 'rows_expired', 'config_changed', 'already_applied', 'failed'];
  for (const b of blockers) assert.ok(keys(msg.blockers).includes(b), `blockers.${b}`);
  for (const s of ['preview', 'applied', 'failed']) assert.ok(keys(msg.status).includes(s), `status.${s}`);
  const rows = msg.rows as Record<string, Record<string, unknown>>;
  for (const f of ROW_FILTERS) assert.ok(keys(rows.filters).includes(f), `rows.filters.${f}`);
  for (const a of ['invalid', 'duplicate_in_file', 'skip_same', 'update_state', 'kept_in_crm', 'rejected_rule', 'stop_list', 'merge', 'create']) {
    assert.ok(keys(rows.action).includes(a), `rows.action.${a}`);
  }
  for (const h of ['dup_pair', 'import_conflict', 'no_working_phone', 'rule']) assert.ok(keys(rows.hold).includes(h), `rows.hold.${h}`);
});

test('плитки сводки, итоги записи и колонки выгрузки имеют текст', () => {
  const tiles = ['create', 'merge', 'duplicateInFile', 'updateState', 'keptInCrm', 'skipSame', 'stopList', 'rejectedRule', 'heldRule', 'heldDupPair', 'heldConflict', 'heldNoPhone', 'unowned', 'needReview', 'agreedWithoutBooking', 'invalid'];
  const summary = msg.summary as Record<string, Record<string, unknown>>;
  for (const k of tiles) assert.ok(keys(summary.tiles).includes(k), `summary.tiles.${k}`);
  const result = msg.result as Record<string, Record<string, unknown>>;
  for (const k of ['clientsCreated', 'clientsMerged', 'cardsCreated', 'cardsUpdated', 'phonesAdded', 'callsCreated', 'pairsCreated', 'tasksCreated', 'stopListed', 'keptInCrm', 'skipped']) {
    assert.ok(keys(result.counts).includes(k), `result.counts.${k}`);
  }
  for (const k of ['row', 'name', 'phones', 'operator', 'outcome', 'answer', 'action', 'hold', 'issues', 'flags']) assert.ok(keys(msg.export).includes(k), `export.${k}`);
});
