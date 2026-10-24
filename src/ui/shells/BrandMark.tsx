'use client';
// Знак в шапке и на входе: логотип клиента или название текстом (D-333). Логотип — обычный <img>: ни next/image,
// ни SVG в разметке (активное содержимое SVG не попадает в документ). Высота фиксирована, ширина по пропорции,
// без перекраски и искажения. Не загрузился — показываем название.
import { useEffect, useRef, useState } from 'react';

/**
 * Высота логотипа, px (D-333): шапка и боковая колонка — 28 px на любой ширине (при 32 px логотип клиента
 * не помещается рядом с колокольчиком), вход — 40 px.
 */
export const BRAND_HEIGHT = { bar: 28, side: 28, auth: 40 } as const;

type Props = { name: string; logoSrc: string | null; size: 'bar' | 'side' | 'auth' };

export function BrandMark({ name, logoSrc, size }: Props) {
  // помним, какой адрес не загрузился: новый адрес (файл заменили, ?v= сменился) пробуем снова
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = logoSrc !== null && failedSrc === logoSrc;
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // ошибка могла случиться до гидратации — onError уже не сработает
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFailedSrc(logoSrc);
  }, [logoSrc]);

  if (!logoSrc || failed) {
    return (
      <strong className="min-w-0 truncate text-lg" data-testid="shell-brand">
        {name}
      </strong>
    );
  }
  return (
    <span className="flex min-w-0" data-testid="shell-brand">
      {/* eslint-disable-next-line @next/next/no-img-element -- файл из тома ассетов (SVG, PNG, WebP); next/image с dangerouslyAllowSVG не используем */}
      <img
        ref={img}
        src={logoSrc}
        alt={name}
        decoding="async"
        onError={() => setFailedSrc(logoSrc)}
        onLoad={() => setFailedSrc(null)}
        style={{ height: BRAND_HEIGHT[size], width: 'auto', maxWidth: '100%', objectFit: 'contain', background: 'var(--logo-plate)', padding: 'var(--logo-pad)', borderRadius: 6, boxSizing: 'content-box' }}
      />
    </span>
  );
}
