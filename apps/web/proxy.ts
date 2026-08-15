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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const firstSegment = pathname.split('/')[1];

  if (pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = `/${segmentForCanonicalLocale(preferredLocale(request))}`;
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
