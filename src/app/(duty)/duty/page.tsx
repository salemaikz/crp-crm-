import { page } from '@/server/access';
import { ComingSoon } from '@/ui/shells';

// Заглушка «Скоро»: владелец раздела заменяет файл настоящей страницей и записью в своём манифесте.
export default page({ perm: 'authenticated' }, async () => <ComingSoon />);
