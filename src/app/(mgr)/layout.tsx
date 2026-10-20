// Layout кабинета руководителя и администратора: оболочка по роли зрителя (боковая навигация на ноутбуке).
// Право на раздел проверяет каждая страница своей обёрткой page().
import type { ReactNode } from 'react';
import { page, type PageContext } from '@/server/access';
import { RoleShell } from '@/ui/shells';

export default page({ perm: 'authenticated' }, async ({ viewer, props }: PageContext<{ children: ReactNode }>) => (
  <RoleShell viewer={viewer}>{props.children}</RoleShell>
));
