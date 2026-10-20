// ВРЕМЕННЫЙ АДАПТЕР (до слияния с K1a). Нормализацию номеров, названий и ФИО делает K1a
// (`packages/core/src/phone`, `names`); импорт зависит только от интерфейса `ImportNormalizers`
// (types.ts). Этот файл даёт рабочую реализацию интерфейса для тестов и предпросмотра, пока модули K1a
// не влиты: координатор заменяет `createTempNormalizers` на адаптер к `core/phone` + `core/names` и
// удаляет файл.
// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (normalizeCompanyName, normalizePersonName,
// phoneKind, isPlaceholderPhone, splitPhones); префиксы теперь параметрами (`phone.*`, CONFIG 6.3).

import { normalizeOrgId } from '../dedup/orgId';
import type { NormalizedPhone, PhoneKind } from '../dedup/types';
import type { ImportNormalizers } from './types';

/** Префиксы номеров из `phone.*`: после «7», цифры; `x` — любая цифра (`71x`). */
export interface PhoneRules {
  mobilePrefixes: readonly string[];
  /** Мобильные с отметкой «проверить номер» (`phone.reviewPrefixes`). */
  reviewPrefixes: readonly string[];
  landlinePrefixes: readonly string[];
}

const OPF_LONG = [
  'товарищество с ограниченной ответственностью',
  'индивидуальный предприниматель',
  'акционерное общество',
  'жауапкершілігі шектеулі серіктестік',
  'жеке кәсіпкер',
];
const OPF_SHORT = /(^|\s)(тоо|ип|ао|жшс|жк|llp|ltd|too)(?=\s|$)/g;

const prefixRe = (p: string) => new RegExp(`^${p.toLowerCase().replace(/x/g, '\\d')}`);

function placeholder(d11: string): boolean {
  const rest = d11.slice(1);
  return '012'.includes(rest[0] ?? '') || new Set(rest).size === 1 || new Set(rest.slice(3)).size === 1;
}

export function createTempNormalizers(rules: PhoneRules): ImportNormalizers {
  const mobile = [...rules.mobilePrefixes, ...rules.reviewPrefixes].map(prefixRe);
  const review = rules.reviewPrefixes.map(prefixRe);
  const landline = rules.landlinePrefixes.map(prefixRe);

  const kindOf = (d: string): PhoneKind => {
    const rest = d.slice(1);
    if (mobile.some((r) => r.test(rest))) return 'mobile';
    if (landline.some((r) => r.test(rest))) return 'landline';
    return 'unknown';
  };

  const normalizeName = (name: string) => {
    let s = (name || '').toLowerCase().replace(/ё/g, 'е');
    for (const f of OPF_LONG) s = s.split(f).join(' ');
    s = s.replace(/["'«»„“”`.,()\-–—/\\]/g, ' ');
    s = s.replace(OPF_SHORT, ' ');
    return s.replace(/\s+/g, ' ').trim();
  };

  return {
    normalizeName,
    normalizePerson: (name) => (name || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim(),
    splitPhones(cell) {
      const out: NormalizedPhone[] = [];
      const seen = new Set<string>();
      for (const chunk of (cell || '').split(/[,;/\n]|\s{2,}/)) {
        const raw = chunk.trim();
        if (!raw) continue;
        let d = raw.replace(/\D+/g, '');
        if (!d) continue;
        if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = `7${d.slice(1)}`;
        else if (d.length === 10) d = `7${d}`;
        const valid = d.length === 11 && d[0] === '7' && !placeholder(d);
        const key = valid ? d : `raw:${raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          valid
            ? { raw, digits: d, kind: kindOf(d), review: review.some((r) => r.test(d.slice(1))) }
            : { raw, digits: null, kind: 'unknown' },
        );
      }
      return out;
    },
    legalFormOf(typeCell, name) {
      const t = typeCell.trim().toLowerCase();
      if (t) return t;
      const n = (name || '').trim().toLowerCase().replace(/ё/g, 'е');
      if (n.startsWith('индивидуальный предприниматель') || /^ип(\s|$)/.test(n)) return 'ип';
      if (n.startsWith('товарищество с ограниченной') || /^тоо(\s|$)/.test(n)) return 'тоо';
      return '';
    },
    normalizeOrgId: (raw) => normalizeOrgId(raw),
  };
}
