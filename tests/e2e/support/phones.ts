// Синтетические номера e2e: только +7 709 … (код не выдан ни одному оператору, AGENTS.md) и без коллизий в прогоне.
// Номер — 7709 и 7 цифр счётчика. Счётчик процесса начинается от времени (мс по модулю 10^7): воркер Playwright,
// перезапущенный после падения, начинает дальше прежнего. Каждый номер сверяется с БД (сотрудники и номера клиентов):
// занятый — прошлые прогоны на той же БД — пропускается. Выданные процессом номера помнятся до вставки.
import type postgres from 'postgres';

const SPACE = 10_000_000;
let seq = -1;
const issued = new Set<string>();

function next(): string {
  seq = seq < 0 ? Date.now() % SPACE : (seq + 1) % SPACE;
  return `7709${String(seq).padStart(7, '0')}`;
}

/** Свободный номер +7 709 … (11 цифр, `7709xxxxxxx`) для сотрудника или клиента. */
export async function uniquePhone(sql: postgres.Sql): Promise<string> {
  for (let i = 0; i < 1_000; i++) {
    const p = next();
    if (issued.has(p)) continue;
    issued.add(p);
    const [row] = await sql<{ taken: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM users WHERE phone_digits = ${p}) OR EXISTS (SELECT 1 FROM client_phones WHERE digits = ${p}) AS taken`;
    if (!row?.taken) return p;
  }
  throw new Error('e2e: не нашлось свободного номера +7 709');
}

/** Метка прогона для имён синтетики («Оператор Сводка <метка>»): строку таблицы ищем по ней, а не по первой. */
export function runTag(): string {
  return `${Date.now().toString(36)}${process.pid.toString(36)}`;
}

/** «8 709 123 45 67» — как номер вводит сотрудник. */
export const pretty = (p: string): string => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
