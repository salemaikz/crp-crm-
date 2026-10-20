// Оболочки по ролям: оператор (нижняя панель), руководитель, консультант и дежурный (боковая на ноутбуке,
// нижняя на телефоне). Пункты — по роли и правам зрителя (menu.ts), подписи — messages/ru/shell.json.
export { RoleShell } from './RoleShell';
export { loadMenu } from './loadMenu';
export { buildMenu, isCurrentPath, shellKindOf, type BuiltMenu, type MenuId, type MenuInput, type MenuItem, type ShellKind } from './menu';
export { ComingSoon } from './ComingSoon';
