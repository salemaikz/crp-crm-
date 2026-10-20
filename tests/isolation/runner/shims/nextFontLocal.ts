// Подмена next/font/local для прогона изоляции: вне Next шрифты не собираются, нужны только имена классов.
export default function localFont(_opts: unknown): { className: string; variable: string; style: { fontFamily: string } } {
  return { className: '', variable: '', style: { fontFamily: 'system-ui' } };
}
