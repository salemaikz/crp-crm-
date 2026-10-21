'use client';

// Кнопка «Уведомления на телефон» в профиле (P8b-2, D-328). Разрешение запрашивается только из нажатия (iOS 16.4+
// даёт push лишь установленному приложению). Нет флага или ключей на сервере — блока нет вовсе.
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { buttonClass, ghostButtonClass } from '../fieldStyles';
import { disablePush, enablePush, pushInfo, type PushInfo } from '@/ui/push';

export function PushToggle() {
  const t = useTranslations('auth.account.push');
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    void pushInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  const refresh = async () => setInfo(await pushInfo());

  if (!info || info.kind === 'hidden') return null;

  async function turnOn() {
    setBusy(true);
    setError(false);
    const r = await enablePush();
    setError(r === 'error' || r === 'unavailable');
    await refresh();
    setBusy(false);
  }
  async function turnOff() {
    setBusy(true);
    setError(false);
    await disablePush();
    await refresh();
    setBusy(false);
  }

  return (
    <section className="flex flex-col gap-3" data-testid="push-toggle" aria-labelledby="push-title">
      <h2 id="push-title" className="text-lg font-medium">
        {t('title')}
      </h2>
      <p className="text-sm">{t('lead')}</p>
      {info.kind === 'unsupported' ? <p className="text-sm">{info.ios ? t('iosInstall') : t('unsupported')}</p> : null}
      {info.kind === 'denied' ? <p className="text-sm">{t('denied')}</p> : null}
      {info.kind === 'off' ? (
        <button type="button" className={buttonClass} disabled={busy} onClick={turnOn}>
          {t('enable')}
        </button>
      ) : null}
      {info.kind === 'on' ? (
        <>
          <p role="status" className="text-sm">{t('on')}</p>
          <button type="button" className={ghostButtonClass} disabled={busy} onClick={turnOff}>
            {t('disable')}
          </button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {t('error')}
        </p>
      ) : null}
    </section>
  );
}
