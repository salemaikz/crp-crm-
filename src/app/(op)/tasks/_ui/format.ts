// Даты задач в поясе установки (не устройства): «28.10, 18:00».
export function formatWhen(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(ms);
}
