// Отчёт → таблица выгрузки (R3b §2.3, D-263): те же колонки, что на экране, плюс доли отдельными колонками. Подписи —
// через переводчик `t` (ключи пространства `reports`) и подписи настроек (источники, типы услуг, типы событий, причины):
// их ключи строит labelKey, а маршрут разрешает через exportTranslator. Данных клиентов в отчётах нет.
import {
  FUNNEL_STEPS,
  type AttendanceReport,
  type ExportColumn,
  type ExportTable,
  type FunnelReport,
  type FunnelRow,
  type OperatorsReport,
  type ReasonsReport,
  type ReportKey,
  type ReportOf,
  type RevenueReport,
  type ToExportTable,
} from './reportTypes';

type T = Parameters<ToExportTable>[2];
type Cell = string | number | null;

export type LabelKind = 'sources' | 'serviceTypes' | 'eventTypes' | 'reasons';

/** Ключ подписи из настроек для переводчика выгрузки: `@<вид>:<ключ>` (для причин — `<группа>/<код>`). */
export function labelKey(kind: LabelKind, key: string): string {
  return `@${kind}:${key}`;
}

/** Подписи настроек, как в getReportMeta. */
export interface ExportLabels {
  sources: Record<string, string>;
  serviceTypes: Record<string, string>;
  eventTypes: Record<string, string>;
  reasons: Record<string, Record<string, string>>;
}

/**
 * Переводчик выгрузки: ключи `@…` — подписи настроек (нет подписи — сам ключ), остальные — локаль `reports`.
 * Без Next: маршрут передаёт сюда готовый переводчик next-intl.
 */
export function exportTranslator(tr: T, labels: ExportLabels): T {
  return (key, values) => {
    const m = /^@(sources|serviceTypes|eventTypes|reasons):(.*)$/s.exec(key);
    if (!m) return tr(key, values);
    const kind = m[1] as LabelKind;
    const k = m[2] as string;
    if (kind === 'reasons') {
      const slash = k.indexOf('/');
      const group = k.slice(0, slash);
      const code = k.slice(slash + 1);
      return labels.reasons[group]?.[code] ?? code;
    }
    return labels[kind][k] ?? k;
  };
}

const col = (key: string, label: string, type: ExportColumn['type']): ExportColumn => ({ key, label, type });

function operators(r: OperatorsReport, t: T): ExportTable {
  const columns: ExportColumn[] = [col('name', t('operators.cols.name'), 'text')];
  const grouped = r.grouping !== 'total';
  if (grouped) columns.push(col('bucket', t('operators.cols.bucket'), 'day'));
  columns.push(
    col('issued', t('operators.cols.issued'), 'int'),
    col('outcomes', t('operators.cols.outcomes'), 'int'),
    col('connects', t('operators.cols.connects'), 'int'),
    col('lpr', t('operators.cols.lpr'), 'int'),
    col('groups', t('operators.cols.groups'), 'int'),
    col('consults', t('operators.cols.consults'), 'int'),
    col('attended', t('operators.cols.attended'), 'int'),
    col('noShow', t('operators.cols.noShow'), 'int'),
    col('attendanceRate', t('operators.cols.attendanceRate'), 'percent'),
    col('purchases', t('operators.cols.purchases'), 'int'),
    col('purchaseSumKzt', t('operators.cols.purchaseSum'), 'money'),
    col('skips', t('operators.cols.skips'), 'int'),
    col('workedHours', t('operators.cols.workedHours'), 'int'),
    col('callsPerHour', t('operators.cols.callsPerHour'), 'percent'),
    col('belowTarget', t('export.cols.belowTarget'), 'text'),
  );
  const metrics = (m: OperatorsReport['totals']): Cell[] => [
    m.issued,
    m.outcomes,
    m.connects,
    m.lpr,
    m.groups,
    m.consults,
    m.attended,
    m.noShow,
    m.attendanceRate,
    m.purchases,
    m.purchaseSumKzt,
    m.skips,
    m.workedHours,
    m.callsPerHour,
  ];
  const rows: Cell[][] = r.rows.map((x) => [x.name, ...(grouped ? [x.bucket] : []), ...metrics(x), x.belowTarget ? t('export.yes') : '']);
  rows.push([t('operators.total'), ...(grouped ? [''] : []), ...metrics(r.totals), '']);
  return { columns, rows };
}

function funnel(r: FunnelReport, t: T): ExportTable {
  const columns: ExportColumn[] = [col('name', t(`funnel.key.${r.by}`), 'text')];
  for (const s of FUNNEL_STEPS) {
    columns.push(col(s, t(`funnel.steps.${s}`), 'int'));
    if (s !== 'issued') columns.push(col(`${s}Rate`, t('export.cols.rateOf', { step: t(`funnel.steps.${s}`) }), 'percent'));
  }
  const nameOf = (x: FunnelRow): string => {
    if (r.by === 'source') return x.key === '' ? t('funnel.unknownSource') : t(labelKey('sources', x.key));
    return x.name ?? x.key;
  };
  const line = (name: string, x: FunnelRow): Cell[] => {
    const out: Cell[] = [name];
    for (const s of FUNNEL_STEPS) {
      out.push(x.counts[s]);
      if (s !== 'issued') out.push(x.rates[s]);
    }
    return out;
  };
  const rows = r.rows.map((x) => line(nameOf(x), x));
  rows.push(line(t('funnel.total'), r.total));
  return { columns, rows };
}

function revenue(r: RevenueReport, t: T): ExportTable {
  const columns = [
    col('type', t('revenue.cols.type'), 'text'),
    col('purchases', t('revenue.cols.purchases'), 'int'),
    col('sumKzt', t('revenue.cols.sum'), 'money'),
    col('firstPurchases', t('revenue.cols.firstPurchases'), 'int'),
    col('firstSumKzt', t('revenue.cols.firstSum'), 'money'),
    col('repeatPurchases', t('revenue.cols.repeatPurchases'), 'int'),
    col('repeatSumKzt', t('revenue.cols.repeatSum'), 'money'),
  ];
  const nums = (x: RevenueReport['total']): Cell[] => [x.purchases, x.sumKzt, x.firstPurchases, x.firstSumKzt, x.repeatPurchases, x.repeatSumKzt];
  const rows: Cell[][] = r.rows.map((x) => [x.serviceTypeKey === '' ? t('revenue.noType') : t(labelKey('serviceTypes', x.serviceTypeKey)), ...nums(x)]);
  rows.push([t('revenue.total'), ...nums(r.total)]);
  return { columns, rows };
}

function attendance(r: AttendanceReport, t: T): ExportTable {
  const columns = [
    col('name', t(`attendance.key.${r.by}`), 'text'),
    col('booked', t('attendance.cols.booked'), 'int'),
    col('attended', t('attendance.cols.attended'), 'int'),
    col('noShow', t('attendance.cols.noShow'), 'int'),
    col('unmarked', t('attendance.cols.unmarked'), 'int'),
    col('cancelled', t('attendance.cols.cancelled'), 'int'),
    col('rate', t('attendance.cols.rate'), 'percent'),
    col('purchases', t('attendance.cols.purchases'), 'int'),
  ];
  const nameOf = (key: string, name: string | null): string => {
    if (r.by === 'event_type') return t(labelKey('eventTypes', key));
    if (key === '') return r.by === 'consultant' ? t('attendance.grey') : t('attendance.noAuthor');
    return name || key;
  };
  const nums = (x: AttendanceReport['total']): Cell[] => [x.booked, x.attended, x.noShow, x.unmarked, x.cancelled, x.rate, x.purchases];
  const rows: Cell[][] = r.rows.map((x) => [nameOf(x.key, x.name), ...nums(x)]);
  rows.push([t('attendance.total'), ...nums(r.total)]);
  return { columns, rows };
}

function reasons(r: ReasonsReport, t: T): ExportTable {
  const columns = [
    col('group', t('reasons.cols.group'), 'text'),
    col('reason', t('reasons.cols.reason'), 'text'),
    col('count', t('reasons.cols.count'), 'int'),
    col('share', t('reasons.cols.share'), 'percent'),
  ];
  const rows: Cell[][] = r.rows.map((x) => [
    t(`reasons.groups.${x.group}`),
    x.reasonCode === '' ? t('reasons.noReason') : t(labelKey('reasons', `${x.group}/${x.reasonCode}`)),
    x.count,
    x.share,
  ]);
  return { columns, rows };
}

export const toExportTable: ToExportTable = <K extends ReportKey>(key: K, report: ReportOf<K>, t: T): ExportTable => {
  switch (key) {
    case 'operators':
      return operators(report as OperatorsReport, t);
    case 'funnel':
      return funnel(report as FunnelReport, t);
    case 'revenue':
      return revenue(report as RevenueReport, t);
    case 'attendance':
      return attendance(report as AttendanceReport, t);
    default:
      return reasons(report as ReasonsReport, t);
  }
};
