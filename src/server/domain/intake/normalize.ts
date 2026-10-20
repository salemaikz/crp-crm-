// Нормализация одной записи партии (INTEGRATIONS 5.2, PROCESS 2.3): чистая функция от настроек, без БД.
// Тот же путь, что у импорта: номера — core/phone, названия и формы — core/names, правила источника — core/dedup.
// ПДн (названия, номера, ИИН) наружу не уходят: результат — только внутренняя структура для записи в БД.
import { dedup, names, phone } from '@crm/core';
import type { GlobalConfigV1 } from '@crm/core/config';
import type { RawItem } from './envelope';
import { emptyDropped, type DroppedFields, type InvalidCode } from './types';

type LegalFormCfg = GlobalConfigV1['org']['legalForms'][number];
type SourceCfg = GlobalConfigV1['sources'][number];
type FieldCfg = GlobalConfigV1['fields'][number];

export interface NormalizeCtx {
  phoneRules: phone.PhoneRules;
  /** Формы собственности для поиска в названии (core/names). */
  coreForms: readonly names.LegalForm[];
  legalForms: readonly LegalFormCfg[];
  idRule: 'kz_bin' | 'none';
  personIdRule: 'kz_iin_hmac' | 'none';
  source: Pick<SourceCfg, 'key' | 'allowPersonNames' | 'detailedReport' | 'rejectRules' | 'holdRules'>;
  /** Поля клиента, в которые можно писать из приёма (`ingest: true`, не в архиве). */
  fields: readonly FieldCfg[];
  iinHmac: (digits: string) => string;
}

export class SourceUnknownError extends Error {
  override name = 'SourceUnknownError';
}

/** Настройки → контекст нормализации. Источника нет в настройках — приём закрыт (fail closed). */
export function buildNormalizeCtx(global: GlobalConfigV1, sourceKey: string, iinHmac: (digits: string) => string): NormalizeCtx {
  const source = global.sources.find((s) => s.key === sourceKey && !s.archived);
  if (!source) throw new SourceUnknownError('источник приёма не найден в настройках');
  const legalForms = global.org.legalForms.filter((f) => !f.archived);
  return {
    phoneRules: {
      country: global.phone.country,
      mobilePrefixes: global.phone.mobilePrefixes,
      reviewPrefixes: global.phone.reviewPrefixes,
      landlinePrefixes: global.phone.landlinePrefixes,
    },
    // Алиас из нескольких слов — полное написание, из одного — аббревиатура
    coreForms: legalForms.map((f) => ({
      key: f.key,
      full: f.aliases.filter((a) => /\s/.test(a.trim())),
      short: f.aliases.filter((a) => !/\s/.test(a.trim())),
    })),
    legalForms,
    idRule: global.org.idRule,
    personIdRule: global.org.personIdRule,
    source,
    fields: global.fields.filter((f) => f.object === 'client' && f.ingest && !f.archived),
    iinHmac,
  };
}

export interface PreparedPhone {
  /** Канон `7XXXXXXXXXX`. */
  digits: string;
  kind: phone.PhoneKind;
  ext: string;
  review: boolean;
}

/** Запись, готовая к дедупу и сохранению. */
export interface Prepared {
  externalId: string | null;
  kind: 'company' | 'person';
  name: string;
  nameNorm: string;
  /** Ключ формы из `org.legalForms` или пусто. */
  legalForm: string;
  /** БИН (12 цифр) или пусто; у формы с `idIsPersonal` всегда пусто. */
  orgId: string;
  /** HMAC ИИН; открытый ИИН дальше этой функции не живёт. */
  iinHmac: string | null;
  phones: PreparedPhone[];
  region: string;
  address: string;
  email: string;
  website: string;
  contactName: string;
  headNorm: string;
  custom: Record<string, unknown>;
  dropped: DroppedFields;
}

export type NormalizeResult =
  | { status: 'invalid'; code: InvalidCode }
  | { status: 'rejected_rule'; ruleCode: string }
  | { status: 'ok'; item: Prepared };

/** Без управляющих символов, пробелы схлопнуты. */
export function cleanText(v: string | null | undefined): string {
  return (v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const EMAIL_RE = /^[^\s@<>"'`()[\]\\,;:]+@[^\s@<>"'`()[\]\\,;:]+\.[^\s@<>"'`()[\]\\,;:.]{2,}$/u;

/** Только адрес; иначе пусто (D-051). */
export function cleanEmail(v: string | null | undefined): { value: string; dropped: boolean } {
  const raw = cleanText(v);
  if (!raw) return { value: '', dropped: false };
  return raw.length <= 254 && EMAIL_RE.test(raw) ? { value: raw, dropped: false } : { value: '', dropped: true };
}

/** Только http(s) (D-051): `javascript:`, `data:`, `vbscript:` и прочее отбрасывается. Без схемы — домен получает https://. */
export function cleanUrl(v: string | null | undefined): { value: string; dropped: boolean } {
  const raw = cleanText(v);
  if (!raw) return { value: '', dropped: false };
  if (/\s/.test(raw)) return { value: '', dropped: true };
  let candidate = raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return { value: '', dropped: true };
  } else if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(\/\S*)?$/u.test(raw)) {
    candidate = `https://${raw}`;
  } else return { value: '', dropped: true };
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { value: '', dropped: true };
    if (!u.hostname || u.username || u.password) return { value: '', dropped: true };
  } catch {
    return { value: '', dropped: true };
  }
  return candidate.length <= 500 ? { value: candidate, dropped: false } : { value: '', dropped: true };
}

/** Значение кастомного поля по типу. `undefined` — значение не годится (поле отбрасывается и считается). */
function fieldValue(f: FieldCfg, v: unknown, ctx: NormalizeCtx): unknown {
  const str = () => (typeof v === 'string' ? cleanText(v) : undefined);
  switch (f.type) {
    case 'text':
    case 'textarea': {
      const t = str();
      return t === undefined || t.length > (f.type === 'text' ? 500 : 5000) ? undefined : t;
    }
    case 'number':
    case 'money': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/\s/g, '').replace(',', '.')) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date': {
      const t = str();
      return t !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`)) ? t : undefined;
    }
    case 'datetime': {
      const t = str();
      return t !== undefined && !Number.isNaN(Date.parse(t)) ? t : undefined;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'select': {
      const t = str();
      return t !== undefined && f.options.some((o) => !o.archived && o.key === t) ? t : undefined;
    }
    case 'multiselect':
      return Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && f.options.some((o) => !o.archived && o.key === x)) ? [...new Set(v as string[])] : undefined;
    case 'phone': {
      const t = str();
      const p = t ? phone.parsePhone(t, ctx.phoneRules) : null;
      return p?.working ? p.digits : undefined;
    }
    case 'email': {
      const r = cleanEmail(str());
      return r.value || undefined;
    }
    case 'url': {
      const r = cleanUrl(str());
      return r.value || undefined;
    }
    default:
      // `user` и всё незнакомое из внешнего источника не принимаем
      return undefined;
  }
}

/** Форма собственности записи: найденная в названии форма с `idIsPersonal` сильнее заявленной (ИП нельзя пометить как ТОО). */
function resolveLegalForm(raw: string, name: string, ctx: NormalizeCtx): LegalFormCfg | null {
  const detectedKey = names.detectLegalForm(name, ctx.coreForms);
  const detected = ctx.legalForms.find((f) => f.key === detectedKey) ?? null;
  if (detected?.idIsPersonal) return detected;
  const declared = raw ? (ctx.legalForms.find((f) => f.key === raw) ?? null) : null;
  return declared ?? detected;
}

export function normalizeItem(raw: RawItem, ctx: NormalizeCtx): NormalizeResult {
  const kind = raw.kind ?? 'company';
  if (kind === 'person' && !ctx.source.allowPersonNames) return { status: 'invalid', code: 'person_not_allowed' };
  const name = cleanText(raw.name);
  if (!name) return { status: 'invalid', code: 'name_required' };

  const dropped = emptyDropped();
  const form = resolveLegalForm(cleanText(raw.legalForm), name, ctx);
  const region = cleanText(raw.region);

  // Правило отклонения источника: ничего не сохраняется, ИИН даже не считаем (D-052)
  const rejected = dedup.evaluateRules(ctx.source.rejectRules, { legalForm: form?.key ?? '', region });
  if (rejected) return { status: 'rejected_rule', ruleCode: rejected.code };

  // БИН / ИИН: у формы с `idIsPersonal` 12 цифр — ИИН, только HMAC (D-052)
  let orgId = '';
  let iinHmac: string | null = null;
  const rawOrg = cleanText(raw.orgId);
  const orgDigits = names.normalizeBin(rawOrg);
  if (rawOrg) {
    if (form?.idIsPersonal) {
      if (orgDigits && ctx.personIdRule === 'kz_iin_hmac') iinHmac = ctx.iinHmac(orgDigits);
      else dropped.orgId++;
    } else if (orgDigits && ctx.idRule === 'kz_bin') orgId = orgDigits;
    else dropped.orgId++;
  }
  const rawIin = cleanText(raw.iin);
  if (rawIin) {
    const d = names.normalizeBin(rawIin);
    if (ctx.personIdRule === 'kz_iin_hmac' && d) iinHmac ??= ctx.iinHmac(d);
    else dropped.iin++;
  }

  // Номера: рабочие, без повторов; заглушки и мусор отбрасываются
  const phones: PreparedPhone[] = [];
  for (const cell of raw.phones ?? []) {
    for (const p of phone.splitPhones(cell, ctx.phoneRules)) {
      if (p.working && p.digits && !phones.some((x) => x.digits === p.digits)) {
        phones.push({ digits: p.digits, kind: p.kind, ext: p.ext, review: p.needsReview });
      }
    }
  }

  const email = cleanEmail(raw.email);
  if (email.dropped) dropped.email++;
  const site = cleanUrl(raw.website);
  if (site.dropped) dropped.website++;

  let contactName = '';
  if (cleanText(raw.contactName)) {
    if (ctx.source.allowPersonNames) contactName = cleanText(raw.contactName);
    else dropped.contactName++;
  }

  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.custom ?? {})) {
    const f = ctx.fields.find((x) => x.key === key);
    if (!f || (f.pii === 'person' && !ctx.source.allowPersonNames)) {
      dropped.custom++;
      continue;
    }
    const v = fieldValue(f, value, ctx);
    if (v === undefined) dropped.custom++;
    else custom[key] = v;
  }

  return {
    status: 'ok',
    item: {
      externalId: cleanText(raw.externalId) || null,
      kind,
      name,
      nameNorm: kind === 'person' ? names.normalizePersonName(name) : names.normalizeCompanyName(name, ctx.coreForms),
      legalForm: form?.key ?? '',
      orgId,
      iinHmac,
      phones,
      region,
      address: cleanText(raw.address),
      email: email.value,
      website: site.value,
      contactName,
      headNorm: names.normalizePersonName(contactName),
      custom,
      dropped,
    },
  };
}

/** Правило задержки источника для нового клиента (клиент создаётся, в раздачу не идёт). */
export function holdRuleOf(item: Pick<Prepared, 'legalForm' | 'region'>, ctx: NormalizeCtx): string | null {
  return dedup.evaluateRules(ctx.source.holdRules, { legalForm: item.legalForm, region: item.region })?.code ?? null;
}
