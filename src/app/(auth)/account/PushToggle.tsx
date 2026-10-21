'use client';

// Кнопка «Уведомления на телефон» в профиле (P8b-2, D-328). Разрешение запрашивается только из нажатия (iOS 16.4+
// даёт push лишь установленному приложению). Нет флага или ключей на сервере — блока нет вовсе. Блок на ките (D-319):
// раздел с заголовком, состояние — сообщением, одна кнопка во всю ширину колонки (касание ≥ 44 px).
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ActionBar, Alert, Button, Section } from '@/ui/kit';
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
    <Section title={t('title')} data-testid="push-toggle" aria-label={t('title')}>
      <p className="text-sm">{t('lead')}</p>
      {info.kind === 'unsupported' ? <Alert tone="info">{info.ios ? t('iosInstall') : t('unsupported')}</Alert> : null}
      {info.kind === 'denied' ? <Alert tone="warning">{t('denied')}</Alert> : null}
      {info.kind === 'on' ? <Alert tone="success">{t('on')}</Alert> : null}
      {error ? <Alert tone="danger">{t('error')}</Alert> : null}
      {info.kind === 'off' || info.kind === 'on' ? (
        <ActionBar>
          {info.kind === 'off' ? (
            <Button variant="secondary" block disabled={busy} onClick={turnOn}>
              {t('enable')}
            </Button>
          ) : (
            <Button variant="secondary" block disabled={busy} onClick={turnOff}>
              {t('disable')}
            </Button>
          )}
        </ActionBar>
      ) : null}
    </Section>
  );
}
