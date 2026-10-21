// Поиск длинных серий цифр (номер, ИИН, БИН) в журнале и отчётах — проверка «ПДн не утекли».
// Известные тесту id записей (UUID, например importId) вырезаются целиком: их hex-группы случайно дают 10+ цифр
// подряд. Вырезается только переданный id и только если это UUID — незнакомый UUID и цифры рядом проверяются.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Текст без известных тесту UUID (каждый заменён на `<id>`): проверка подстрок номера («555») и серий цифр не ловит
 * случайные цифры id. Не UUID — ошибка: так в «известные» не попадёт сам номер.
 */
export function withoutKnownIds(text: string, knownIds: readonly string[]): string {
  let rest = text;
  for (const id of knownIds) {
    if (!UUID_RE.test(id)) throw new Error(`withoutKnownIds: id должен быть UUID, получено ${JSON.stringify(id)}`);
    rest = rest.split(id).join('<id>');
  }
  return rest;
}

export function digitRunsExcept(text: string, knownIds: readonly string[], minDigits = 10): string[] {
  return withoutKnownIds(text, knownIds).match(new RegExp(`\\d{${minDigits},}`, 'g')) ?? [];
}
