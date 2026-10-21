'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Page, PageHeader } from '@/ui/kit';
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
      setJustSaved(null);
      setEpoch((n) => n + 1);
    }
  }

  // какой раздел только что сохранён: форма пересоздаётся с новыми значениями, отметка «Сохранено» переживает это
  const [justSaved, setJustSaved] = useState<'sales' | 'holidays' | null>(null);

  const accept = (section: 'sales' | 'holidays') => (v: SalesSettingsView) => {
    setData(v);
    setJustSaved(section);
    setEpoch((n) => n + 1);
  };

  return (
    <Page width="form">
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
        <SalesSettingsForm key={`s${epoch}`} data={data} justSaved={justSaved === 'sales'} onSaved={accept('sales')} onConflict={() => setConflict(true)} />
        <HolidaysEditor key={`h${epoch}`} data={data} justSaved={justSaved === 'holidays'} onSaved={accept('holidays')} onConflict={() => setConflict(true)} />
      </div>
    </Page>
  );
}
