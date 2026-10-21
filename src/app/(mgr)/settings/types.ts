// Типы клиентского экрана — копия формы ответа API (клиенту нельзя импортировать домен).
export type Holiday = { date: string; kind: 'holiday' | 'workday'; note: string };

export type SalesSettingsView = {
  revs: { global: number; space: number };
  values: {
    dailyCap: number | null;
    schedule: { from: string; to: string; everyMin: number } | null;
    callWindow: { start: string; end: string };
    callsPerHourTarget: number | null;
  };
  holidays: Holiday[];
  can: { sales: boolean; holidays: boolean };
  year: number;
};
