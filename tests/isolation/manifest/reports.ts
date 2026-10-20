// Манифест изоляции отчётов (R1a): сводка дня РОП. Раздел (target = 'section'): сводку видит охват пространства
// (РОП, директор); оператор, консультант и руководитель отдела получают 403, гость — 401. Только чтение.
import { defineManifest } from '../harness/manifest';

export default defineManifest('reports', [
  { kind: 'page', path: '/(mgr)/summary', method: 'GET', perm: 'report.view', target: 'section', mutation: false },
  { kind: 'route', path: '/api/reports/summary', method: 'GET', perm: 'report.view', target: 'section', mutation: false },
]);
