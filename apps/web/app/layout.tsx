import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ConvexClientProvider } from '@/app/convex-client-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sancocho',
  description: 'Sancocho logistics operations platform',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="es">
        <body>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
