// @crm/core: чистая логика без БД и Next. Зависит только от zod.
// Каталоги появляются вместе с задачами: calling/, time/, phone/, names/, dedup/, distribution/,
// import/, booking/, config/, fields/, access/, license/ (docs/ARCHITECTURE.md §3).
// Время приходит параметром `now`; Date.now() внутри ядра не вызывается.
export {};
