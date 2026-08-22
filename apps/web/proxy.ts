import { NextRequest, NextResponse } from 'next/server';

import {
  canonicalLocaleForSegment,
  canonicalLocaleFromAcceptLanguage,
  isCanonicalLocale,
  isLocaleSegment,
  localeCookieName,
  segmentForCanonicalLocale,
} from './i18n/locales';

function preferredLocale(request: NextRequest) {
  const persisted = request.cookies.get(localeCookieName)?.value;
  if (persisted !== undefined && isCanonicalLocale(persisted)) return persisted;
  return canonicalLocaleFromAcceptLanguage(request.headers.get('accept-language'));
}

/**
 * The application's landing view. `docs/web-design.md` §14: chat is the
 * primary/default surface (#32) — an operator describes what they need in
 * prose rather than starting from a list.
 *
 * The redirect happens here rather than in the `/[locale]` page because the
 * application layout renders a client shell: by the time a `redirect()` inside
 * that page runs, the response has begun streaming, so Next can only express it
 * as a soft client-side navigation — a 200 plus a visible flash of empty shell.
 * Redirecting at the proxy is a real 307 before anything renders.
 */
const landingPath = '/chat';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const firstSegment = pathname.split('/')[1];

  if (pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = `/${segmentForCanonicalLocale(preferredLocale(request))}${landingPath}`;
    return NextResponse.redirect(url);
  }

  if (firstSegment !== undefined && isLocaleSegment(firstSegment) && pathname === `/${firstSegment}`) {
    const url = request.nextUrl.clone();
    url.pathname = `/${firstSegment}${landingPath}`;
    return NextResponse.redirect(url);
  }

  if (firstSegment !== undefined && isLocaleSegment(firstSegment)) {
    const canonicalLocale = canonicalLocaleForSegment(firstSegment);
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-sancocho-locale', canonicalLocale);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.cookies.set(localeCookieName, canonicalLocale, {
      path: '/',
      maxAge: 31_536_000,
      sameSite: 'lax',
    });
    return response;
  }

  const url = request.nextUrl.clone();
  url.pathname = `/${segmentForCanonicalLocale(preferredLocale(request))}${pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
