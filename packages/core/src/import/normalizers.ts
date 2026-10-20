// Нормализаторы импорта поверх `core/phone` и `core/names`: интерфейс `ImportNormalizers`
// не знает о конкретных правилах, они приходят настройками (`global.phone`, формы собственности).
import {
  DEFAULT_LEGAL_FORMS,
  detectLegalForm,
  legalFormCode,
  legalFormOfTypeCell,
  normalizeBin,
  normalizeCompanyName,
  normalizePersonName,
  personalFormCodes,
  type LegalForm,
} from '../names';
import { splitPhones, type PhoneRules } from '../phone';
import type { ImportNormalizers } from './types';

export function createImportNormalizers(rules: PhoneRules, forms: readonly LegalForm[] = DEFAULT_LEGAL_FORMS): ImportNormalizers {
  return {
    normalizeName: (raw) => normalizeCompanyName(raw, forms),
    normalizePerson: normalizePersonName,
    splitPhones: (cell) =>
      splitPhones(cell, rules).map((p) => ({
        raw: p.raw,
        // Заглушка сохраняет цифры в ParsedPhone, но для импорта она «нерабочая»: digits = null.
        digits: p.working ? p.digits : null,
        kind: p.kind,
        review: p.needsReview,
      })),
    legalFormOf(typeCell, name) {
      // Колонка «Тип» главнее названия, но её значение тоже приводится к коду формы: «ИП.»,
      // «Индивидуальный предприниматель», «ЖК», «Жеке кәсіпкер» → `ип` (иначе правила для ИП и
      // признак «номер — личный» не срабатывают, D-052). Не распознали — форма из названия.
      const typed = typeCell.trim();
      const fromType = typed ? legalFormOfTypeCell(typed, forms) : null;
      const key = fromType ?? detectLegalForm(name, forms);
      return { code: legalFormCode(key, forms), typeUnknown: typed !== '' && fromType === null };
    },
    normalizeOrgId: (raw) => normalizeBin(raw) || null,
    personalFormCodes: personalFormCodes(forms),
  };
}
