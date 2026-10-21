'use client';

// Полоса лицензии над страницей (P10b). Администратор может свернуть её до следующей загрузки; состояние — в памяти
// страницы, не в хранилище (D-327). Текст уже переведён на сервере. Отступы и место задаёт ShellBanner (D-319).
import { X } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/ui/kit';

export type BannerView = { tone: 'info' | 'warn' | 'danger'; text: string; dismissible: boolean; dismissLabel: string };

export function LicenseBannerBar({ banner }: { banner: BannerView }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div data-testid="license-banner" data-tone={banner.tone}>
      <Alert tone={banner.tone === 'warn' ? 'warning' : banner.tone}>
        <div className="flex items-start justify-between gap-2">
          <span>{banner.text}</span>
          {banner.dismissible ? (
            <button type="button" aria-label={banner.dismissLabel} onClick={() => setHidden(true)} className="-m-2 inline-flex min-h-11 min-w-11 items-center justify-center">
              <X aria-hidden="true" size={18} />
            </button>
          ) : null}
        </div>
      </Alert>
    </div>
  );
}
