'use client';

// Полная выгрузка (R3b §2.5, D-264): пароль ещё раз → билет (POST JSON) → скрытая форма POST с билетом, браузер сам
// скачивает архив. Пароль не уходит в адрес; билет живёт 60 с и гасится сервером при первом использовании.
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Modal } from '@/ui/kit';

type Failure = 'password_invalid' | 'export_limit' | 'busy' | 'rate_limited' | 'forbidden' | 'network' | 'generic';

const LIMIT_CODES: readonly Failure[] = ['export_limit', 'busy', 'rate_limited'];

async function requestTicket(password: string): Promise<{ ok: true; ticket: string } | { ok: false; key: Failure }> {
  try {
    const res = await fetch('/api/export/full/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as { ticket?: unknown; detail?: unknown };
    if (res.ok && typeof body.ticket === 'string') return { ok: true, ticket: body.ticket };
    if (res.status === 403) return { ok: false, key: body.detail === 'password_invalid' ? 'password_invalid' : 'forbidden' };
    if (res.status === 429) return { ok: false, key: LIMIT_CODES.find((c) => c === body.detail) ?? 'rate_limited' };
    return { ok: false, key: 'generic' };
  } catch {
    return { ok: false, key: 'network' };
  }
}

export function FullExportDialog({ limit }: { limit: number }) {
  const t = useTranslations('reports.full');
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const ticketInput = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setPassword('');
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password === '' || busy) return;
    setBusy(true);
    setError(null);
    const r = await requestTicket(password);
    setBusy(false);
    setPassword('');
    if (!r.ok) {
      setError(r.key);
      return;
    }
    // билет — в скрытое поле и сразу отправка формы: ответ с вложением браузер скачает, страница останется
    if (ticketInput.current && form.current) {
      ticketInput.current.value = r.ticket;
      form.current.submit();
      ticketInput.current.value = '';
    }
    setStarted(true);
    setOpen(false);
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('button')}
      </Button>
      {started && (
        <Alert tone="info" className="mt-2">
          {t('started')}
        </Alert>
      )}
      <form ref={form} method="post" action="/api/export/full" hidden aria-hidden="true">
        <input ref={ticketInput} type="hidden" name="ticket" defaultValue="" />
      </form>
      <Modal
        open={open}
        onClose={close}
        title={t('title')}
        closeLabel={t('cancel')}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t('cancel')}
            </Button>
            <Button type="submit" form="full-export-form" disabled={busy || password === ''}>
              {t('submit')}
            </Button>
          </>
        }
      >
        <form id="full-export-form" onSubmit={submit} className="flex flex-col gap-3">
          <p>{t('lead', { limit })}</p>
          <Field label={t('password')} error={error === 'password_invalid' ? t('errors.password_invalid') : undefined}>
            <Input type="password" name="password" autoComplete="current-password" value={password} onChange={(ev) => setPassword(ev.target.value)} />
          </Field>
          {error && error !== 'password_invalid' && <Alert tone="warning">{t(`errors.${error}`)}</Alert>}
        </form>
      </Modal>
    </>
  );
}
