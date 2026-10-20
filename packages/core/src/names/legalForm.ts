// Формы собственности для нормализации названий. Список приходит параметром из настроек;
// DEFAULT_LEGAL_FORMS — значение по умолчанию продукта (РК: ТОО, ИП, АО и их казахские формы).
// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (OPF, OPF_SHORT).

export interface LegalForm {
  /** Ключ формы (для правил отбраковки вроде «только ИП»). */
  key: string;
  /** Полные названия (любой регистр, любая буква ё/е). */
  full: readonly string[];
  /** Аббревиатуры, как отдельное слово. */
  short: readonly string[];
}

export const DEFAULT_LEGAL_FORMS: readonly LegalForm[] = [
  {
    key: 'llp',
    full: ['товарищество с ограниченной ответственностью', 'жауапкершілігі шектеулі серіктестік'],
    short: ['тоо', 'жшс', 'llp', 'ltd', 'too'],
  },
  {
    key: 'sole_proprietor',
    full: ['индивидуальный предприниматель', 'жеке кәсіпкер'],
    short: ['ип', 'жк'],
  },
  { key: 'jsc', full: ['акционерное общество'], short: ['ао'] },
];
