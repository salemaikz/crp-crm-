// Поиск длинных серий цифр (номер, ИИН, БИН) в журнале и отчётах — проверка «ПДн не утекли».
// Известные тесту id записей (UUID, например importId) вырезаются целиком: их hex-группы случайно дают 10+ цифр
// подряд. Вырезается только переданный id и только если это UUID — незнакомый UUID и цифры рядом проверяются.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function digitRunsExcept(text: string, knownIds: readonly string[], minDigits = 10): string[] {
  let rest = text;
  for (const id of knownIds) {
    if (!UUID_RE.test(id)) throw new Error(`digitRunsExcept: id должен быть UUID, получено ${JSON.stringify(id)}`);
    rest = rest.split(id).join('<id>');
  }
  return rest.match(new RegExp(`\\d{${minDigits},}`, 'g')) ?? [];
}
