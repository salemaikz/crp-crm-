'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { markDeviceOwner } from '@/ui/call/deviceOwner';
import { browserStorage } from '@/ui/call/logoutPending';
import { buttonClass, errorClass, inputClass } from '../fieldStyles';

type Preview = { name: string; phoneMasked: string };
type Phase = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'ready'; preview: Preview };
type PasswordKey = 'tooShort' | 'tooLong' | 'tooCommon' | 'sameAsPhone';

const PASSWORD_ERRORS: Record<string, PasswordKey> = {
  too_short: 'tooShort',
  too_long: 'tooLong',
  too_common: 'tooCommon',
  same_as_phone: 'sameAsPhone',
};

export function InviteForm() {
  const t = useTranslations('auth.invite');
  const tp = useTranslations('auth.password');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Токен только в памяти компонента: ни в localStorage, ни в адресной строке (D-094)
  const token = useRef('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode в dev запускает эффект дважды, а фрагмент уже стёрт
    started.current = true;
    token.current = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/invite');
    if (!token.current) {
      setPhase({ kind: 'invalid' });
      return;
    }
    fetch('/api/auth/invite/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.current }),
    })
      .then(async (res) => {
        if (!res.ok) return setPhase({ kind: 'invalid' });
        setPhase({ kind: 'ready', preview: (await res.json()) as Preview });
      })
      .catch(() => {
        setPhase({ kind: 'invalid' });
      });
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password !== repeat) {
      setError(t('mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.current, password }),
      });
      if (res.ok) {
        const data = (await res.json()) as { next: string; userId?: string };
        // Метка владельца телефона (D-292), как при входе
        if (data.userId) markDeviceOwner(browserStorage(), data.userId);
        window.location.assign(data.next);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number };
      if (res.status === 404) setPhase({ kind: 'invalid' });
      else if (res.status === 429) setError(t('rateLimited', { sec: data.retryAfterSec ?? 1 }));
      else if (data.error && PASSWORD_ERRORS[data.error]) setError(tp(PASSWORD_ERRORS[data.error] as PasswordKey));
      else setError(t('network'));
    } catch {
      setError(t('network'));
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === 'loading') return <p role="status">{t('loading')}</p>;
  if (phase.kind === 'invalid') return <p role="alert" className={errorClass}>{t('invalid')}</p>;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title', { name: phase.preview.name })}</h1>
        <p className="text-neutral-600">{t('lead', { phone: phase.preview.phoneMasked })}</p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('password')}
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('repeat')}
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <p className="text-sm text-neutral-600">{t('rules')}</p>
        {error && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}
        <button type="submit" className={buttonClass} disabled={busy}>
          {t('submit')}
        </button>
      </form>
    </>
  );
}
