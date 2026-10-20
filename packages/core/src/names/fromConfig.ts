// Формы собственности из настроек (`global.org.legalForms[]`, CONFIG §6.1) → список для нормализации
// названий. Алиас из одного слова до 6 букв — аббревиатура (`short`), всё остальное — полное название
// (`full`). Архивные формы остаются: старые названия клиентов должны нормализоваться так же.
// Признак `idIsPersonal` переносится как есть: без него импорт и приём не узнают «личную» форму (D-141).
import type { LegalForm } from './legalForm.js';

export interface LegalFormSetting {
  key: string;
  aliases: readonly string[];
  /** 12 цифр у формы — ИИН (D-052). В настройках обязателен; здесь необязателен для старых вызовов. */
  idIsPersonal?: boolean;
}

const SHORT_MAX = 6;

function isShortAlias(alias: string): boolean {
  return !/\s/.test(alias) && alias.length <= SHORT_MAX;
}

export function legalFormsFromConfig(forms: readonly LegalFormSetting[]): LegalForm[] {
  return forms.map((f) => {
    const aliases = f.aliases.map((a) => a.trim()).filter((a) => a !== '');
    return {
      key: f.key,
      full: aliases.filter((a) => !isShortAlias(a)),
      short: aliases.filter(isShortAlias),
      ...(f.idIsPersonal !== undefined ? { idIsPersonal: f.idIsPersonal } : {}),
    };
  });
}
