import { SignUp } from '@clerk/nextjs';

import { defaultLocale, isLocaleSegment, segmentForCanonicalLocale } from '@/i18n/locales';

export default async function SignUpPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const segment = isLocaleSegment(locale) ? locale : segmentForCanonicalLocale(defaultLocale);
  return <SignUp path={`/${segment}/sign-up`} signInUrl={`/${segment}/sign-in`} />;
}
