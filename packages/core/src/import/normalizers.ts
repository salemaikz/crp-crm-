// Нормализаторы импорта поверх `core/phone` и `core/names`: интерфейс `ImportNormalizers`
// не знает о конкретных правилах, они приходят настройками (`global.phone`, формы собственности).
import { DEFAULT_LEGAL_FORMS, detectLegalForm, normalizeBin, normalizeCompanyName, normalizePersonName, type LegalForm } from '../names';
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
      const typed = typeCell.trim().toLowerCase();
      if (typed) return typed;
      // Форма из названия — короткий код (`тоо`, `ип`, `ао`): так её ждут правила и профиль.
      const key = detectLegalForm(name, forms);
      return forms.find((f) => f.key === key)?.short[0] ?? '';
    },
    normalizeOrgId: (raw) => normalizeBin(raw) || null,
  };
}
