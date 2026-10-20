// Тестовый профиль импорта «таблицы операторов» и вспомогательные функции тестов.
// Значения — данные профиля (в продукте они лежат в настройках, CONFIG 6.13), не код ядра.

import { createHash } from 'node:crypto';
import { DEFAULT_DEDUP_SETTINGS } from '../dedup/types';
import type { PhoneRules } from '../phone';
import { createImportNormalizers } from './normalizers';
import { compileProfile, parseSheet, type CompiledProfile } from './parse';
import type { ImportProfile, KeyHashFn, OperatorSlot, ParsedRow } from './types';
import { IMPORT_FIELDS as F } from './types';

export const TEST_PHONE_RULES: PhoneRules = {
  country: 'KZ',
  mobilePrefixes: ['700', '701', '702', '703', '704', '705', '706', '707', '708', '709', '747', '750', '751', '760', '761', '762', '763', '764', '771', '775', '776', '777', '778'],
  reviewPrefixes: ['770', '774'],
  landlinePrefixes: ['71x', '72x'],
  stubs: ['7xxx0000000'],
};

export const testHash: KeyHashFn = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const normalizers = createImportNormalizers(TEST_PHONE_RULES);
export { DEFAULT_DEDUP_SETTINGS };

export function testProfile(slots: readonly OperatorSlot[], over: Partial<ImportProfile> = {}): ImportProfile {
  return {
    key: 'operator-tables',
    columns: {
      Тип: F.legalForm, Наименование: F.name, Регион: F.region, Руководитель: F.head, ОКЭД: F.activity, Телефон: F.phones,
      Адрес: F.address, 'ЛПР подтвержден': F.lpr, Ответ: F.outcome, Статус: F.status, 'Точная ниша': F.niche, Заметка: F.note,
    },
    valueMaps: {
      outcome: {
        'Отключен/Не берет': 'no_answer', Отключен: 'no_answer', 'Не берет': 'no_answer',
        Перезвонить: 'callback', Недоступен: 'bad_number', 'Не имеет отношение': 'bad_number',
        Закрылся: 'not_target', 'Не интересует': 'not_interested', 'Полный отказ': 'do_not_call', Подтвержден: 'agreed',
      },
      lpr: { да: 'yes', нет: 'no' },
      target: { целевой: 'target', 'не целевой': 'non_target' },
    },
    ownerBy: { kind: 'row_ranges', slots },
    outcomePriority: ['do_not_call', 'not_target', 'agreed', 'not_interested', 'bad_number', 'callback', 'no_answer'],
    outcomeKinds: {
      no_answer: 'no_answer', callback: 'callback', bad_number: 'bad_number', not_target: 'not_target',
      not_interested: 'not_interested', do_not_call: 'do_not_call', agreed: 'agreed',
    },
    snapshotDate: '2026-10-23',
    noteMarkers: [
      { code: 'dnc_request', words: ['не звонить', 'удалить'] },
      { code: 'sensitive', words: ['[личное]'] },
    ],
    personalIdForms: ['ип'],
    ...over,
  };
}

export function parseOrThrow(grid: string[][], profile: ImportProfile): { rows: ParsedRow[]; cp: CompiledProfile } {
  const cp = compileProfile(profile);
  const r = parseSheet(grid, cp, { normalizers, hash: testHash });
  if (!r.ok) throw new Error(`header: ${r.missing.join(',')}`);
  return { rows: r.rows, cp };
}
