'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, PageHeader } from '@/ui/kit';
import { send } from './api';
import { HolidaysEditor } from './HolidaysEditor';
import { SalesSettingsForm } from './SalesSettingsForm';
import type { SalesSettingsView } from './types';

/** Экран: разделы по `can`. Конфликт ревизий в любом разделе — одна плашка с кнопкой «Обновить». */
export function SettingsScreen({ initial }: { initial: SalesSettingsView }) {
  const t = useTranslations('settings');
  const [data, setData] = useState(initial);
  const [conflict, setConflict] = useState(false);
  // ключ формы: после чужой правки или обновления поля пересоздаются из новых значений
  const [epoch, setEpoch] = useState(0);

  async function refresh() {
    const r = await send('GET', '/api/admin/settings/sales');
    if (r.ok) {
      setData(r.data);
      setConflict(false);
      setEpoch((n) => n + 1);
    }
  }

  const accept = (v: SalesSettingsView) => {
    setData(v);
    setEpoch((n) => n + 1);
  };

  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      <div className="flex flex-col gap-8">
        {conflict && (
          <Alert tone="warning">
            <p>{t('sales.conflict')}</p>
            <Button variant="secondary" size="sm" onClick={refresh}>
              {t('sales.refresh')}
            </Button>
          </Alert>
        )}
        <SalesSettingsForm key={`s${epoch}`} data={data} onSaved={accept} onConflict={() => setConflict(true)} />
        <HolidaysEditor key={`h${epoch}`} data={data} onSaved={accept} onConflict={() => setConflict(true)} />
      </div>
    </>
  );
}
