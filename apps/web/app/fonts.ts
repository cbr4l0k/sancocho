import { Chivo, Chivo_Mono } from 'next/font/google';

/**
 * Both faces come from Omnibus-Type (Buenos Aires), drawn for Spanish first, so
 * the accented vowels and `ñ` that dominate this UI are original outlines rather
 * than bolted-on composites. `latin-ext` is requested explicitly: without it the
 * subset that ships covers `á é í ó ú ñ` but drops the wider Latin range a
 * multi-tenant customer list will eventually contain.
 *
 * `next/font/google` downloads and self-hosts the files at build time, so no
 * request ever leaves for a font CDN and the strict CSP is satisfied.
 * `display: 'swap'` plus the adjusted fallback keeps first paint readable.
 */
export const chivo = Chivo({
  subsets: ['latin', 'latin-ext'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-chivo',
  fallback: ['ui-sans-serif', 'sans-serif'],
});

export const chivoMono = Chivo_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: 'variable',
  display: 'swap',
  variable: '--font-chivo-mono',
  fallback: ['ui-monospace', 'monospace'],
});
