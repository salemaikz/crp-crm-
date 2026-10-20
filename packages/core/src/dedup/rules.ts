// Правила источника `rejectRules` / `holdRules` (CONFIG 6.4, PROCESS 2.3 п. 6–7):
// reject — запись не сохраняется вовсе, hold — клиент создаётся, но в раздачу не идёт.
// Значения форм и регионов приходят из настроек; ядро их не знает.

export type SourceRuleType = 'legalFormIn' | 'regionNotIn';

export interface SourceRule {
  code: string;
  type: SourceRuleType;
  values: readonly string[];
}

export interface RuleSubject {
  /** Форма собственности в нормализованном виде (результат `core/names`): `ип`, `тоо`; пусто, если неизвестна. */
  legalForm: string;
  /** Регион как в источнике. */
  region: string;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/**
 * Первое сработавшее правило или `null`.
 * `legalFormIn`: форма записи входит в `values`.
 * `regionNotIn`: регион непустой и не содержит ни одного из `values` (подстрока, регистр не важен).
 * Неизвестный регион правило не срабатывает: утверждать «не тот регион» без данных нельзя.
 */
export function evaluateRules(rules: readonly SourceRule[], subject: RuleSubject): SourceRule | null {
  const form = norm(subject.legalForm);
  const region = norm(subject.region);
  for (const rule of rules) {
    const values = rule.values.map(norm).filter(Boolean);
    if (rule.type === 'legalFormIn' && form !== '' && values.includes(form)) return rule;
    if (rule.type === 'regionNotIn' && region !== '' && !values.some((v) => region.includes(v))) return rule;
  }
  return null;
}
