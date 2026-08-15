import type { ReactNode } from 'react';

import { ApplicationShell } from '@/components/application/app-shell';

export default function ApplicationLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <ApplicationShell>{children}</ApplicationShell>;
}
