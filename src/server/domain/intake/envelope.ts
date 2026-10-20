// Конверт партии (INTEGRATIONS 5.2 п. 2): типы и размеры. Ошибка конверта — 400 на всю партию, в ответе только пути и коды.
// Содержательные ошибки записи (нет названия, физлицо при запрете) — статус `invalid` по записи, не здесь.
import { z } from 'zod';

export interface EnvelopeIssue {
  path: string;
  code: string;
}

const s = (max: number) => z.string().max(max).nullish();

const ItemSchema = z.object({
  externalId: s(100),
  kind: z.enum(['company', 'person']).nullish(),
  name: s(500),
  legalForm: s(100),
  orgId: s(100),
  iin: s(100),
  phones: z.array(z.string().max(40)).max(10).nullish(),
  region: s(500),
  address: s(500),
  email: s(254),
  website: s(500),
  contactName: s(200),
  custom: z.record(z.unknown()).nullish(),
});

export type RawItem = z.infer<typeof ItemSchema>;

export interface Batch {
  batchId: string;
  items: RawItem[];
}

function codeOf(i: z.ZodIssue): string {
  switch (i.code) {
    case 'too_big':
      return i.type === 'array' ? 'too_many' : 'too_long';
    case 'too_small':
      return i.type === 'array' ? 'too_few' : 'too_short';
    case 'invalid_type':
      return i.received === 'undefined' ? 'required' : 'invalid_type';
    case 'invalid_string':
      return 'invalid_format';
    case 'invalid_enum_value':
      return 'invalid_value';
    default:
      return 'invalid';
  }
}

/** Проверка тела по схеме с пределом числа записей (`intake.maxBatch`). Значения полей в ошибки не попадают. */
export function parseEnvelope(body: unknown, maxBatch: number): { ok: true; batch: Batch } | { ok: false; issues: EnvelopeIssue[] } {
  const schema = z.object({ batchId: z.string().uuid(), items: z.array(ItemSchema).min(1).max(maxBatch) });
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, batch: r.data };
  return { ok: false, issues: r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), code: codeOf(i) })) };
}
