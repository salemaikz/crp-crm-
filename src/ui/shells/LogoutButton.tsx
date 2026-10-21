'use client';

// Кнопка «Выйти»: сначала уходят неотправленные итоги, потом закрывается сессия. Если итоги не ушли (нет сети),
// показываем предупреждение: выйти можно, но итоги останутся на телефоне до следующего входа. Итоги со свободным
// текстом оператора (заметка, данные ЛПР) на телефоне не остаются (D-293): «Всё равно выйти» для них нет — либо
// остаться до сети, либо удалить их с явным подтверждением потери.
import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { finishLogout, flushDeviceOutbox } from '@/ui/call/logout';
import { Alert, Button } from '@/ui/kit';

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'unsent'; count: number; freeText: number }
  | { kind: 'confirm'; count: number; freeText: number };

export function LogoutButton({ userId, className, side }: { userId: string; className?: string; side?: boolean }) {
  const t = useTranslations('shell.logout');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const start = async () => {
    setPhase({ kind: 'busy' });
    const left = await flushDeviceOutbox(userId);
    if (left.count > 0) {
      setPhase({ kind: 'unsent', ...left });
      return;
    }
    const res = await finishLogout(userId);
    // Пока шла отправка, в другой вкладке появился итог со свободным текстом
    if (res.kind === 'confirm') setPhase({ kind: 'unsent', count: res.freeText, freeText: res.freeText });
  };

  const force = async (count: number) => {
    const res = await finishLogout(userId);
    if (res.kind === 'confirm') setPhase({ kind: 'unsent', count: Math.max(count, res.freeText), freeText: res.freeText });
  };

  if (phase.kind === 'confirm') {
    return (
      <Alert tone="danger" title={t('discardTitle', { count: phase.freeText })} data-testid="logout-discard-ask">
        <p className="text-sm">{t('discardText')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPhase({ ...phase, kind: 'unsent' })} data-testid="logout-discard-back">
            {t('back')}
          </Button>
          <Button variant="danger" size="sm" onClick={() => void finishLogout(userId, { discardFreeText: true })} data-testid="logout-discard-confirm">
            {t('discardConfirm')}
          </Button>
        </div>
      </Alert>
    );
  }

  if (phase.kind === 'unsent') {
    const withText = phase.freeText > 0;
    return (
      <Alert tone="warning" title={t('unsent', { count: phase.count })} data-testid="logout-unsent">
        <p className="text-sm">{withText ? t('freeTextHint', { count: phase.freeText }) : t('hint')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPhase({ kind: 'idle' })} data-testid="logout-stay">
            {t('stay')}
          </Button>
          {withText ? (
            <Button variant="secondary" size="sm" onClick={() => setPhase({ ...phase, kind: 'confirm' })} data-testid="logout-discard">
              {t('discard')}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => void force(phase.count)} data-testid="logout-force">
              {t('force')}
            </Button>
          )}
        </div>
      </Alert>
    );
  }
  return (
    <Button
      variant="danger-quiet"
      block
      className={side ? `justify-start gap-2 px-3 ${className ?? ''}` : className}
      disabled={phase.kind === 'busy'}
      onClick={() => void start()}
      data-testid="logout"
    >
      {side ? <LogOut aria-hidden="true" /> : null}
      {phase.kind === 'busy' ? t('busy') : t('button')}
    </Button>
  );
}
