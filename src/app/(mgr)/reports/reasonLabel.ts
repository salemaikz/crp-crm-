'use client';

// Подпись причины отчёта: из настроек, для неявок — вид мероприятия, для системного списания — из локали.
import { useTranslations } from 'next-intl';
import type { ReasonRow, ReportLabels } from './types';

export function useReasonLabel(labels: ReportLabels): (r: Pick<ReasonRow, 'group' | 'reasonCode'>) => string {
  const t = useTranslations('reports.reasons');
  return (r) => {
    if (r.group === 'no_show') return labels.eventTypes[r.reasonCode] ?? r.reasonCode; // неявки — по виду мероприятия
    if (r.reasonCode === '') return r.group === 'callback' ? t('withoutReason') : t('noReason');
    const fromSettings = labels.reasons[r.group]?.[r.reasonCode];
    if (fromSettings !== undefined) return fromSettings;
    return r.group === 'written_off' && (r.reasonCode === 'no_answer_limit' || r.reasonCode === 'no_working_phone') ? t(`system.${r.reasonCode}`) : r.reasonCode;
  };
}
