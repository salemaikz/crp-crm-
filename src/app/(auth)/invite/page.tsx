import type { Metadata } from 'next';
import { InviteForm } from './InviteForm';

// Статическая: токен во фрагменте `#` на сервер не приходит, читает его только браузер (D-094).
// Referrer-Policy и Cache-Control для /invite ставит src/proxy.ts.
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } };

export default function InvitePage() {
  return <InviteForm />;
}
