// Сотрудники стенда: роли — ключи из пресета (operator, rop, consultant, director, marketing_head).
// Номера служебные, +7 709 100 00 NN; у клиентов после кода идёт цифра 2–9, пересечений нет.

export interface StaffSpec {
  /** Устойчивый ключ для id и отчёта. */
  key: string;
  phone: string;
  name: string;
  /** Ключ роли в пространстве; null — только администратор установки без роли. */
  role: 'operator' | 'rop' | 'consultant' | 'director' | 'marketing_head' | null;
  admin?: boolean;
  /** Участвует в раздаче (операторы). */
  distribution?: boolean;
  /** Команда пространства (ключ), если есть. */
  team?: string;
}

const phone = (n: number): string => `770910000${String(n).padStart(2, '0')}`;

export const OPERATOR_NAMES = ['Айдана Оператор', 'Берик Оператор', 'Виктория Оператор', 'Габит Оператор', 'Дарина Оператор'] as const;

export function staffSpecs(operators: number): StaffSpec[] {
  const list: StaffSpec[] = [
    { key: 'admin', phone: phone(1), name: 'Админ Стенда', role: null, admin: true },
    { key: 'rop', phone: phone(2), name: 'Руслан Руководитель', role: 'rop' },
    { key: 'duty', phone: phone(3), name: 'Дина Дежурная', role: 'rop' },
  ];
  for (let i = 0; i < operators; i++) {
    list.push({ key: `operator${i + 1}`, phone: phone(4 + i), name: OPERATOR_NAMES[i] ?? `Оператор ${i + 1}`, role: 'operator', distribution: true });
  }
  const n = 4 + operators;
  list.push(
    { key: 'consultant1', phone: phone(n), name: 'Камила Консультант', role: 'consultant' },
    { key: 'consultant2', phone: phone(n + 1), name: 'Леонид Консультант', role: 'consultant' },
    { key: 'director', phone: phone(n + 2), name: 'Мурат Директор', role: 'director' },
    { key: 'marketing_head', phone: phone(n + 3), name: 'Надежда Маркетинг', role: 'marketing_head', team: 'marketing' },
  );
  return list;
}
