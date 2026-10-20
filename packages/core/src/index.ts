// @crm/core: чистая логика без БД и Next. Зависит только от zod.
// Сервер импортирует ядро только как '@crm/core' (D-101: в production это один файл dist/index.cjs,
// подпути не поддерживаются), поэтому модули выставлены пространствами имён:
//   import { calling, time } from '@crm/core';  calling.applyOutcome(...);  time.createWorkCalendar(...)
// Каталоги появляются вместе с задачами (docs/ARCHITECTURE.md §3).
// Время приходит параметром `now`; Date.now() внутри ядра не вызывается.
export * as access from './access';
export * as booking from './booking';
export * as calling from './calling';
export * as config from './config';
export * as dedup from './dedup';
export * as distribution from './distribution';
export * as fields from './fields';
// `import` — зарезервированное слово, поэтому пространство называется `imports`.
export * as imports from './import';
export * as license from './license';
export * as names from './names';
export * as phone from './phone';
export * as time from './time';
