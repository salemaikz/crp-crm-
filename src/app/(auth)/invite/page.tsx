import type { Metadata } from 'next';
import { AuthBrand } from '@/ui/shells/AuthBrand';
import { InviteForm } from './InviteForm';

// Читает только настройки (логотип, D-333): токен во фрагменте `#` на сервер не приходит, читает его только браузер (D-094).
// Referrer-Policy и Cache-Control для /invite ставит src/proxy.ts.
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } };

export default function InvitePage() {
  return (
    <>
      <AuthBrand />
      <InviteForm />
    </>
  );
}
