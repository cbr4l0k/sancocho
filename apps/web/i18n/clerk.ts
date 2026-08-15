import { enUS, esMX } from '@clerk/localizations';

/**
 * Clerk does not ship an es-CO bundle. es-MX is the deliberate Latin-American
 * stand-in: es-ES uses vosotros and peninsular vocabulary that read poorly in
 * Colombia.
 */
export const clerkLocalizations = {
  'es-CO': esMX,
  'en-US': enUS,
} as const;
