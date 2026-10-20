// Манифест изоляции отчётов (R1a, R3a): сводка дня РОП и отчёты за период. Раздел (target = 'section'): сводку видит охват пространства
// (РОП, директор); оператор, консультант и руководитель отдела получают 403, гость — 401. Только чтение.
import { defineManifest } from '../harness/manifest';

export default defineManifest('reports', [
  { kind: 'page', path: '/(mgr)/summary', method: 'GET', perm: 'report.view', target: 'section', mutation: false },
  { kind: 'route', path: '/api/reports/summary', method: 'GET', perm: 'report.view', target: 'section', mutation: false },
  // Отчёты за период (R3a): тот же охват — пространство и шире
  { kind: 'page', path: '/(mgr)/reports', method: 'GET', perm: 'report.view', target: 'section', mutation: false },
  { kind: 'route', path: '/api/reports/[key]', method: 'GET', perm: 'report.view', target: 'section', mutation: false },
]);
