import { ImageResponse } from 'next/og';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { computeTheme } from '@/ui/theme';

// Иконка приложения: трубка на цвете бренда из темы установки. Рисуется на запросе (цвет живёт в настройках),
// шрифты не нужны — только фигура.
export const dynamic = 'force-dynamic';
export const contentType = 'image/png';

export function generateImageMetadata() {
  return [
    { id: '192', size: { width: 192, height: 192 }, contentType: 'image/png' },
    { id: '512', size: { width: 512, height: 512 }, contentType: 'image/png' },
  ];
}

const HANDSET =
  'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z';

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const px = Number(await id) === 192 ? 192 : 512;
  const config = await getActiveConfigOrNull();
  const { vars } = computeTheme(config?.global.theme);
  const bg = vars['--brand'] ?? '#2457c5';
  const fg = vars['--on-brand'] ?? '#ffffff';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${fg}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${HANDSET}"/></svg>`;
  const src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg }}>
        <img src={src} width={Math.round(px * 0.6)} height={Math.round(px * 0.6)} alt="" />
      </div>
    ),
    { width: px, height: px },
  );
}
