import { redirect } from 'next/navigation';
import { page } from '@/server/access';
import { loadMenu } from '@/ui/shells';

// Корень: перенаправляет на главную роли — первый доступный пункт её меню (оператор → /call,
// РОП и директор → /summary, консультант → /consultations). Без входа обёртка отправляет на /login.
export default page({ perm: 'authenticated' }, async ({ viewer }) => {
  const { home } = await loadMenu(viewer);
  redirect(home);
});
