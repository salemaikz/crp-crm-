// Правило «не больше одного слоя модалок»: диалог и нижний лист занимают единственный слой.
// Второй не открывается (в разработке — ошибка в консоли). Подтверждение внутри шторки — встроенным
// блоком в ней же, а не вторым диалогом. Чистые функции — их проверяют юнит-тесты.

const layers = new Set<string>();

/** Занять слой. false — слой уже занят другим, открывать второй нельзя. */
export function acquireLayer(id: string): boolean {
  if (layers.size > 0 && !layers.has(id)) return false;
  layers.add(id);
  return true;
}

export function releaseLayer(id: string): void {
  layers.delete(id);
}

export function openLayerCount(): number {
  return layers.size;
}

/** Только для тестов. */
export function resetLayers(): void {
  layers.clear();
}
