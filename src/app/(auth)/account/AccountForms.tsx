'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { buttonClass, errorClass, ghostButtonClass, inputClass } from '../fieldStyles';

type PasswordKey = 'tooShort' | 'tooLong' | 'tooCommon' | 'sameAsPhone' | 'sameAsCurrent' | 'wrongCurrent';

const ERRORS: Record<string, PasswordKey> = {
  too_short: 'tooShort',
  too_long: 'tooLong',
  too_common: 'tooCommon',
  same_as_phone: 'sameAsPhone',
  same_as_current: 'sameAsCurrent',
  wrong_current: 'wrongCurrent',
};

async function post(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function AccountForms() {
  const t = useTranslations('auth.account');
  const tp = useTranslations('auth.password');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function change(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await post('/api/auth/password', { current, next });
      if (res.ok) {
        setDone(true);
        setCurrent('');
        setNext('');
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number };
        const key = data.error ? ERRORS[data.error] : undefined;
        if (data.error === 'unauthorized') window.location.replace('/login?next=/account');
        else if (res.status === 429) setError(t('rateLimited', { sec: data.retryAfterSec ?? 1 }));
        else if (key) setError(tp(key));
        else setError(t('network'));
      }
    } catch {
      setError(t('network'));
    } finally {
      setBusy(false);
    }
  }

  async function logoutAll() {
    setBusy(true);
    try {
      await post('/api/auth/logout-all');
    } finally {
      window.location.replace('/login');
    }
  }

  return (
    <>
      <form onSubmit={change} className="flex flex-col gap-4" noValidate>
        <h2 className="text-lg font-medium">{t('change')}</h2>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('current')}
          <input className={inputClass} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('new')}
          <input className={inputClass} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}
        {done && <p role="status" className="rounded-lg bg-success-tint px-3 py-2 text-sm text-success">{t('done')}</p>}
        <button type="submit" className={buttonClass} disabled={busy}>
          {t('save')}
        </button>
      </form>
      <section className="flex flex-col gap-3">
        {confirming ? (
          <>
            <p>{t('logoutAllConfirm')}</p>
            <button type="button" className={buttonClass} disabled={busy} onClick={logoutAll}>
              {t('logoutAll')}
            </button>
          </>
        ) : (
          <button type="button" className={ghostButtonClass} onClick={() => setConfirming(true)}>
            {t('logoutAll')}
          </button>
        )}
      </section>
    </>
  );
}
