import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';

import { ConvexClientProvider } from '@/app/convex-client-provider';
import './globals.css';

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="es-CO">
        <body>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
