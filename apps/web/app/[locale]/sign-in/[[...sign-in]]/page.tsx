import { SignIn } from '@clerk/nextjs';

import { defaultLocale, isLocaleSegment, segmentForCanonicalLocale } from '@/i18n/locales';

export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const segment = isLocaleSegment(locale) ? locale : segmentForCanonicalLocale(defaultLocale);
  return <SignIn path={`/${segment}/sign-in`} signUpUrl={`/${segment}/sign-up`} />;
}
