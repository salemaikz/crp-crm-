// Доступ в ядре: закрытый каталог разрешений, отношения, схема раздела ролей и валидатор,
// действующие права роли. Без БД и Next; SQL охвата — в src/server/access.
export * from './catalog';
export * from './relations';
export * from './roles';
export * from './roleValidator';
export * from './capability';
