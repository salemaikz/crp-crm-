// Словарь форм ядра (значение по умолчанию) не расходится с пресетом kz: те же ключи и тот же признак
// «номер — ИИН» (D-141). Иначе форма, распознанная ядром, могла бы хранить ИИН открыто (D-052).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// JSON — импортом, а не чтением файла: ядро не работает с ФС (правило lint), esbuild встраивает JSON в сборку
// тестов core:check.
import presetKz from '../../../../presets/kz/preset.json' with { type: 'json' };
import { DEFAULT_LEGAL_FORMS, legalFormCode, personalFormCodes } from './index';

interface PresetForm {
  key: string;
  aliases: string[];
  idIsPersonal: boolean;
}

const presetForms = new Map((presetKz.global.org.legalForms as PresetForm[]).map((f) => [f.key, f]));

test('словарь ядра ⊆ пресет kz по ключам и признаку личности', () => {
  for (const f of DEFAULT_LEGAL_FORMS) {
    const p = presetForms.get(f.key);
    assert.ok(p, `формы ${f.key} нет в пресете kz`);
    assert.equal(p.idIsPersonal, f.idIsPersonal ?? false, `idIsPersonal у ${f.key}`);
    // Код формы ядра (`тоо`, `кх`) — среди написаний пресета.
    const code = legalFormCode(f.key);
    assert.ok(p.aliases.some((a) => a.toLowerCase() === code), `${f.key}: код ${code} не среди aliases пресета`);
  }
});

test('«личные» формы словаря ядра — ИП и КХ', () => {
  assert.deepEqual(personalFormCodes(), ['ип', 'кх']);
});
