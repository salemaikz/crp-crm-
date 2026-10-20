// Layout дежурного по встрече (явка гостей): оболочка «дежурный» независимо от роли. Право на раздел проверяет страница.
import type { ReactNode } from 'react';
import { page, type PageContext } from '@/server/access';
import { RoleShell } from '@/ui/shells';

export default page({ perm: 'authenticated' }, async ({ viewer, props }: PageContext<{ children: ReactNode }>) => (
  <RoleShell viewer={viewer} force="duty">{props.children}</RoleShell>
));
