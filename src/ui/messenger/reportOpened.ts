// Отметка «Открыт WhatsApp» в ленту: общая для основной кнопки карточки и кнопки в строке номера.

/** «Открыт WhatsApp» в ленту: без ожидания и без влияния на открытие ссылки; офлайн не шлём. */
export function reportOpened(cardId: string): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  void fetch('/api/messenger/opened', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, templateKey: null }), keepalive: true }).catch(() => {});
}
