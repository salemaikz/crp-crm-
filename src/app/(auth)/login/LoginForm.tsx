'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { formatPhoneInput } from '@/shared/phoneMask';
import { buttonClass, errorClass, inputClass } from '../fieldStyles';

type ErrorKey = 'invalid' | 'validation' | 'network' | null;

export function LoginForm() {
  const t = useTranslations('auth.login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey>(null);
  const [wait, setWait] = useState(0); // секунд до следующей попытки

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  function onPhone(value: string) {
    // стёрли знак маски — убираем последнюю цифру, иначе маска вернула бы его на место
    const digits = (s: string) => s.replace(/\D/g, '').length;
    const next = value.length < phone.length && digits(value) === digits(phone) ? value.slice(0, -1) : value;
    setPhone(formatPhoneInput(next));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      const next = new URLSearchParams(window.location.search).get('next') ?? undefined;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password, ...(next ? { next } : {}) }),
      });
      if (res.ok) {
        const data = (await res.json()) as { next: string };
        window.location.assign(data.next); // полная загрузка: cookie уже стоит
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number };
      if (data.retryAfterSec) setWait(data.retryAfterSec);
      if (res.status === 400) setError('validation');
      else if (res.status === 401) setError('invalid');
      else if (res.status !== 429) setError('network'); // 429: сообщение даёт обратный отсчёт
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t('phone')}
        <input
          className={inputClass}
          type="tel"
          inputMode="tel"
          autoComplete="username"
          name="phone"
          placeholder={t('phoneHint')}
          value={phone}
          onChange={(e) => onPhone(e.target.value)}
        />
      </label>
      <div className="flex flex-col gap-1">
        <label htmlFor="login-password" className="text-sm font-medium">
          {t('password')}
        </label>
        <div className="flex gap-2">
          <input
            id="login-password"
            className={inputClass}
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="min-h-11 shrink-0 rounded-lg border border-neutral-300 px-3 text-sm"
            aria-pressed={show}
            onClick={() => setShow((s) => !s)}
          >
            {show ? t('hide') : t('show')}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className={errorClass}>
          {t(error)}
        </p>
      )}
      {wait > 0 && (
        <p role="status" className={errorClass}>
          {t('rateLimited', { sec: wait })}
        </p>
      )}
      <button type="submit" className={buttonClass} disabled={busy || wait > 0}>
        {busy ? t('submitting') : t('submit')}
      </button>
    </form>
  );
}
