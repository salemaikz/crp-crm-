'use client';

// Кнопка «Выйти»: сначала уходят неотправленные итоги, потом закрывается сессия. Если итоги не ушли (нет сети),
// показываем предупреждение: выйти можно, но итоги останутся на телефоне до следующего входа.
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { finishLogout, flushDeviceOutbox } from '@/ui/call/logout';
import { Alert, Button } from '@/ui/kit';

type Phase = { kind: 'idle' } | { kind: 'busy' } | { kind: 'unsent'; count: number };

export function LogoutButton({ userId, className }: { userId: string; className?: string }) {
  const t = useTranslations('shell.logout');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const start = async () => {
    setPhase({ kind: 'busy' });
    const left = await flushDeviceOutbox(userId);
    if (left > 0) setPhase({ kind: 'unsent', count: left });
    else await finishLogout(userId);
  };

  if (phase.kind === 'unsent') {
    return (
      <Alert tone="warning" title={t('unsent', { count: phase.count })} data-testid="logout-unsent">
        <p className="text-sm">{t('hint')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPhase({ kind: 'idle' })} data-testid="logout-stay">
            {t('stay')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void finishLogout(userId)} data-testid="logout-force">
            {t('force')}
          </Button>
        </div>
      </Alert>
    );
  }
  return (
    <Button variant="quiet" block className={className} disabled={phase.kind === 'busy'} onClick={() => void start()} data-testid="logout">
      {phase.kind === 'busy' ? t('busy') : t('button')}
    </Button>
  );
}
