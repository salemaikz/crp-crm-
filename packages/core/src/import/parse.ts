// Разбор таблицы по профилю импорта (CONFIG 6.13): заголовки находятся по названиям, а не по позиции.
// Идея и поиск строки заголовков — SalemAI 108fb70 src/lib/crm/coldImport.ts (angelRowsFromGrid),
// переписано под профиль: карта колонок, карты значений, владелец и ключи D-048 из настроек.

import { compileMaps, isContradiction, normalizeLabel, parseAnswerCell, parseLpr, parseTarget, type CompiledMaps } from './answer';
import { importKeyOf, rowKeyOf, stateKeyOf } from './keys';
import {
  DEFAULT_STATE_FIELDS,
  IMPORT_FIELDS as F,
  type ImportNormalizers,
  type ImportProfile,
  type KeyHashFn,
  type ParsedRow,
  type ParseSheetResult,
  type RowIssue,
} from './types';

export interface ParseDeps {
  normalizers: ImportNormalizers;
  hash: KeyHashFn;
}

/** Дата в тексте заметки («набрать 14.10», «до 5/11»): подсказка, автоматически не планируется. */
const DATE_IN_NOTE = /(^|[^\d])(0?[1-9]|[12]\d|3[01])[./](0?[1-9]|1[0-2])(?![\d])/;

/** Профиль, подготовленный к разбору (карты значений с нормализованными ключами). */
export interface CompiledProfile {
  profile: ImportProfile;
  maps: CompiledMaps;
  /** Нормализованный заголовок → ключ поля. */
  columns: Map<string, string>;
  stateFields: readonly string[];
}

export function compileProfile(profile: ImportProfile): CompiledProfile {
  return {
    profile,
    maps: compileMaps(profile),
    columns: new Map(Object.entries(profile.columns).map(([h, f]) => [normalizeLabel(h), f])),
    stateFields: profile.stateFields ?? DEFAULT_STATE_FIELDS,
  };
}

const REQUIRED_FIELDS = [F.name, F.phones];

export function parseSheet(grid: readonly (readonly string[])[], cp: CompiledProfile, deps: ParseDeps): ParseSheetResult {
  const scan = Math.min(grid.length, cp.profile.headerScanRows ?? 10);
  let headerIdx = -1;
  let colOf = new Map<string, number>();
  let unmapped: string[] = [];
  for (let h = 0; h < scan; h++) {
    const cells = (grid[h] ?? []).map((c) => normalizeLabel(String(c ?? '')));
    const cols = new Map<string, number>();
    cells.forEach((label, i) => {
      const field = cp.columns.get(label);
      if (field && !cols.has(field)) cols.set(field, i);
    });
    if (REQUIRED_FIELDS.every((f) => cols.has(f))) {
      headerIdx = h;
      colOf = cols;
      unmapped = cells.filter((c, i) => c && !cp.columns.has(c) && ![...cols.values()].includes(i));
      break;
    }
  }
  if (headerIdx < 0) {
    const known = new Set(cp.columns.values());
    return { ok: false, error: 'header_not_found', missing: REQUIRED_FIELDS.filter((f) => ![...known].includes(f)) };
  }

  // Коды «личных» форм: профиль может написать форму как угодно («ИП», «Индивидуальный предприниматель»).
  const personal = new Set(
    (cp.profile.personalIdForms ?? []).map((x) => deps.normalizers.legalFormOf(x, '').code || x.trim().toLowerCase()).filter(Boolean),
  );
  const rows: ParsedRow[] = [];
  let skippedBlank = 0;
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    const fields: Record<string, string> = {};
    for (const [field, col] of colOf) fields[field] = String(raw[col] ?? '').trim();
    if (!fields[F.name] && !fields[F.phones]) {
      skippedBlank++; // пустые строки в хвосте листа
      continue;
    }
    rows.push(buildRow(i + 1, fields, cp, deps, personal));
  }
  return { ok: true, headerRow: headerIdx + 1, rows, unmappedHeaders: unmapped, skippedBlank };
}

function buildRow(
  rowNo: number,
  fields: Record<string, string>,
  cp: CompiledProfile,
  { normalizers: n, hash }: ParseDeps,
  personal: ReadonlySet<string>,
): ParsedRow {
  const issues: RowIssue[] = [];
  const get = (f: string) => fields[f] ?? '';
  const name = get(F.name);
  const head = get(F.head);
  const form = n.legalFormOf(get(F.legalForm), name);
  const legalForm = form.code;
  const phones = n.splitPhones(get(F.phones));
  const workingPhones = [...new Set(phones.flatMap((p) => (p.digits ? [p.digits] : [])))];
  const stubPhones = [...new Set(phones.flatMap((p) => (p.digits ? [] : [p.raw.replace(/\D+/g, '')])).filter(Boolean))];
  const nameNorm = n.normalizeName(name);
  const headNorm = n.normalizePerson(head);

  const answer = parseAnswerCell(get(F.outcome), cp.maps);
  const lpr = parseLpr(get(F.lpr), cp.maps);
  const target = parseTarget(get(F.status), cp.maps);
  const outcomeKey = answer.primary;
  const outcomeKind = outcomeKey ? (cp.profile.outcomeKinds[outcomeKey] ?? null) : null;

  if (!name) issues.push({ code: 'no_name', severity: 'error' });
  if (phones.length === 0) issues.push({ code: 'no_phone', severity: 'info' });
  else if (workingPhones.length === 0) issues.push({ code: 'no_working_phone', severity: 'info' });
  if (phones.length > 1) issues.push({ code: 'many_phones', severity: 'info' });
  if (phones.some((p) => p.review)) issues.push({ code: 'phone_review', severity: 'info' });
  if (answer.unknown.length > 0) issues.push({ code: 'unknown_answer', severity: 'review', detail: answer.unknown.join(', ') });
  if (lpr === null) issues.push({ code: 'unknown_lpr', severity: 'review' });
  if (target === null) issues.push({ code: 'unknown_status', severity: 'review' });
  if (isContradiction(target, outcomeKind)) issues.push({ code: 'contradiction', severity: 'review' });
  if (/\d/.test(head)) issues.push({ code: 'head_has_digits', severity: 'info' });
  if (form.typeUnknown) issues.push({ code: 'unknown_legal_form', severity: 'review' });

  const noteFlags: string[] = [];
  const note = get(F.note).toLowerCase();
  for (const m of cp.profile.noteMarkers ?? []) {
    if (m.words.some((w) => w && note.includes(w.toLowerCase()))) noteFlags.push(m.code);
  }
  if (DATE_IN_NOTE.test(get(F.note))) noteFlags.push('date_in_note');
  for (const code of noteFlags) if (code !== 'date_in_note') issues.push({ code: `note_${code}`, severity: 'review' });

  const orgId = n.normalizeOrgId(get(F.orgId));
  // D-052, D-141: ИИН не должен попасть в базу открыто. Форма не определена (пусто или «Тип» не
  // распознан) — тоже «личный», но «по неуверенности»: предпросмотр сверяет такой ключ с открытыми БИН
  // базы и файла, совпал — это БИН и склейка не теряется.
  const personalForm = personal.has(legalForm);
  const orgIdPersonal = !!orgId && personal.size > 0 && (personalForm || legalForm === '' || form.typeUnknown);
  const orgIdUncertain = orgIdPersonal && !personalForm;

  return {
    rowNo,
    fields,
    legalForm,
    name,
    nameNorm,
    head,
    headNorm,
    region: get(F.region),
    orgId,
    orgIdPersonal,
    orgIdUncertain,
    phones,
    workingPhones,
    stubPhones,
    answer,
    lpr,
    target,
    outcomeKey,
    outcomeKind,
    operatorLabel: get(F.operator) || null,
    noteFlags,
    rowKey: rowKeyOf(cp.profile.key, { nameNorm, headNorm, workingPhones, stubPhones, legalForm }, hash),
    stateKey: stateKeyOf(fields, cp.stateFields, hash),
    issues,
  };
}

export { importKeyOf };
