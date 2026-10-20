'use client';

import { useTranslations } from 'next-intl';
import { Alert, Button, Field, Input, useToast } from '@/ui/kit';

type Props = { link: string; ttlHours: number; onDone: () => void };

/** Ссылка показывается один раз: хранится только в состоянии открытого окна и исчезает при закрытии. */
export function LinkView({ link, ttlHours, onDone }: Props) {
  const t = useTranslations('team.link');
  const ta = useTranslations('team.actions');
  const toast = useToast();

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      toast.show({ message: t('copied'), tone: 'success' });
    } catch {
      document.getElementById('field-link')?.focus(); // onFocus выделяет текст для ручного копирования
      toast.show({ message: t('copyFailed'), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p>{t('lead', { hours: ttlHours })}</p>
      <Field label={t('field')}>
        <Input name="link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <Alert tone="warning">{t('once')}</Alert>
      <div className="flex flex-wrap gap-3">
        <Button onClick={copy}>{t('copy')}</Button>
        <Button variant="secondary" onClick={onDone}>
          {ta('done')}
        </Button>
      </div>
    </div>
  );
}
