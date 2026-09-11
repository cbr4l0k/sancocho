import type { ReactNode } from 'react';

import { PortalShell } from '@/components/portal/portal-shell';

export default function PortalLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <PortalShell>{children}</PortalShell>;
}
