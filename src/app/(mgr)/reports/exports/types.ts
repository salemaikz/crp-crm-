// Формы данных журнала выгрузок для клиентского экрана (src/server/** клиенту недоступен). page.tsx присваивает им форму
// из домена, расхождение ловит typecheck.
export type JournalRow = {
  id: string;
  at: number;
  actorUserId: string | null;
  actorName: string | null;
  kind: 'report' | 'full' | 'guests';
  reportKey: string | null;
  format: string;
  rows: number;
  filterKeys: string[];
  periodDays: number | null;
};

export type JournalPage = { rows: JournalRow[]; next: { at: number; id: string } | null };
