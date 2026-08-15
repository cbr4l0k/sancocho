'use client';

import { UserButton } from '@clerk/nextjs';
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api } from '@sancocho/convex/api';

import { LocaleSwitcher } from '@/app/[locale]/locale-switcher';
import { CurrentOrganizationProvider, useCurrentOrganization } from '@/components/organizations/current-organization';
import { Button } from '@/components/ui/button';
import { EmptyState, UnavailableState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { errorMessageKey, presentConvexError, type ConvexErrorPresentation } from '@/lib/convex-errors';
import { segmentForCanonicalLocale } from '@/i18n/locales';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type ApplicationShellProps = { children: ReactNode };

export function ApplicationShell({ children }: ApplicationShellProps) {
  /* Guard order: AuthLoading → Unauthenticated → Authenticated → provisioning → organization.
   * Stage-G screens mount as children in ShellFrame and inherit nav, org context, and error handling.
   */
  return (
    <>
      <AuthLoading>
        <ShellLoading />
      </AuthLoading>
      <Unauthenticated>
        <SignedOut />
      </Unauthenticated>
      <Authenticated>
        <ProvisionedShell>{children}</ProvisionedShell>
      </Authenticated>
    </>
  );
}

function ShellLoading() {
  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-8 sm:px-6 lg:py-12" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      <SkeletonText className="mt-5 max-w-md" />
    </main>
  );
}

function SignedOut() {
  const locale = useLocale();
  const t = useTranslations();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[88rem] items-center px-6 py-8">
      <Panel emphasis="focal" className="mx-auto w-full max-w-[30rem]">
        <PanelHeader>
          <PanelTitle className="text-display font-extrabold tracking-[-0.025em]">
            {t('auth.signedOutTitle')}
          </PanelTitle>
          <PanelDescription>{t('auth.signedOut')}</PanelDescription>
        </PanelHeader>
        <PanelBody className="flex-row flex-wrap items-center">
          <Button variant="primary" render={<Link href={`/${segmentForCanonicalLocale(locale)}/sign-in`} />}>
            {t('auth.signIn')}
          </Button>
          <Button variant="secondary" render={<Link href={`/${segmentForCanonicalLocale(locale)}/sign-up`} />}>
            {t('auth.signUp')}
          </Button>
        </PanelBody>
      </Panel>
    </main>
  );
}

function ProvisionedShell({ children }: ApplicationShellProps) {
  const user = useQuery(api.auth.queries.getCurrentUser);
  const ensureUser = useMutation(api.auth.mutations.ensureUser);
  const requested = useRef(false);
  const locale = useLocale();
  const router = useRouter();
  const [error, setError] = useState<ConvexErrorPresentation | null>(null);

  useEffect(() => {
    if (user !== null || requested.current) return;
    requested.current = true;
    void ensureUser().catch((caught: unknown) => {
      const presentation = presentConvexError(caught);
      if (presentation === 'errors.unauthenticated') {
        router.replace(`/${segmentForCanonicalLocale(locale)}/sign-in`);
        return;
      }
      setError(presentation);
    });
  }, [ensureUser, locale, router, user]);

  // A Clerk session can exist before Convex has provisioned its app user. Keep
  // this distinct from the organization check below so that window never redirects.
  if (error !== null) return <ShellError presentation={error} />;
  if (user === undefined || user === null) return <ShellLoading />;

  return <OrganizationGate>{children}</OrganizationGate>;
}

function ShellError({ presentation }: { presentation: ConvexErrorPresentation }) {
  const t = useTranslations();

  return (
    <main className="mx-auto flex w-full max-w-[88rem] px-4 py-8 sm:px-6 lg:py-12">
      {presentation === 'errors.notFound' ? (
        <UnavailableState />
      ) : (
        <EmptyState tone="unavailable" title={t(errorMessageKey(presentation))} />
      )}
    </main>
  );
}

function OrganizationGate({ children }: ApplicationShellProps) {
  const organizations = useQuery(api.organizations.queries.listMyOrganizations);
  if (organizations === undefined) return <ShellLoading />;

  return (
    <CurrentOrganizationProvider organizations={organizations}>
      {organizations.length === 0 ? <CreateOrganization /> : <ShellFrame>{children}</ShellFrame>}
    </CurrentOrganizationProvider>
  );
}

function CreateOrganization() {
  const t = useTranslations();
  const createOrganization = useMutation(api.organizations.mutations.createOrganization);
  const { selectCreatedOrganization } = useCurrentOrganization();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<'invalid' | ConvexErrorPresentation | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slugPattern.test(slug) || slug.length < 3 || slug.length > 63) {
      setError('invalid');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const organizationId = await createOrganization({ name, slug });
      selectCreatedOrganization(organizationId);
    } catch (caught: unknown) {
      setError(presentConvexError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const errorText =
    error === 'invalid'
      ? t('organizations.slugInvalid')
      : error === 'errors.conflict'
        ? t('organizations.slugTaken')
        : error === null
          ? null
          : t(errorMessageKey(error));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[88rem] items-center px-6 py-8">
      <Panel emphasis="focal" className="mx-auto w-full max-w-[34rem]">
        <PanelHeader>
          <div>
            <PanelTitle className="text-display font-extrabold tracking-[-0.025em]">
              {t('organizations.createTitle')}
            </PanelTitle>
            <PanelDescription>{t('organizations.createDescription')}</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Field>
              <FieldLabel required>{t('organizations.nameLabel')}</FieldLabel>
              <FieldControl required value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field invalid={error === 'invalid'}>
              <FieldLabel required>{t('organizations.slugLabel')}</FieldLabel>
              <FieldControl required value={slug} onChange={(event) => setSlug(event.target.value)} />
              <FieldDescription>{t('organizations.slugDescription')}</FieldDescription>
              {errorText === null ? null : <FieldError>{errorText}</FieldError>}
            </Field>
            <div>
              <Button variant="primary" type="submit" disabled={submitting}>
                {t('organizations.createAction')}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>
    </main>
  );
}

function ShellFrame({ children }: ApplicationShellProps) {
  const { currentOrganization, organizations, selectOrganization } = useCurrentOrganization();
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations();
  const segment = segmentForCanonicalLocale(locale);
  // Nav visibility is presentation only, never authorization (I1); the server is sole authority.
  const nav = [
    { href: `/${segment}`, label: t('nav.chat') },
    { href: `/${segment}/recipes`, label: t('nav.recipes') },
    { href: `/${segment}/services`, label: t('nav.services') },
    { href: `/${segment}/projects`, label: t('nav.projects') },
    { href: `/${segment}/locations`, label: t('nav.locations') },
    { href: `/${segment}/fields`, label: t('nav.fields') },
    { href: `/${segment}/statistics`, label: t('nav.statistics') },
  ];

  return (
    <div className="min-h-dvh bg-ground-0">
      <header className="h-16 border-b border-line bg-ground-0">
        <div className="mx-auto flex h-full w-full max-w-[88rem] items-center gap-4 px-6">
          <Link
            href={`/${segment}`}
            className="flex shrink-0 items-center gap-2 text-lg font-extrabold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <span aria-hidden="true" className="size-2.5 rounded-full bg-accent" />
            {t('nav.application')}
          </Link>
          <nav aria-label={t('nav.label')} className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex w-max min-w-full items-center justify-center gap-0.5 rounded-pill bg-ground-1 p-1">
              {nav.map((item) => {
                return (
                  <Button
                    key={item.href}
                    variant="ghost"
                    size="sm"
                    selected={pathname === item.href}
                    render={<Link href={item.href} />}
                  >
                    {item.label}
                  </Button>
                );
              })}
            </div>
          </nav>
          <div className="flex shrink-0 items-center gap-3">
            <div className="relative flex h-[34px] max-w-48 items-center gap-2 rounded-pill bg-ground-1 px-3 text-sm font-semibold text-ink">
              <span className="truncate">{currentOrganization?.organization.name}</span>
              <svg aria-hidden="true" className="size-3 shrink-0 text-ink-3" viewBox="0 0 12 12">
                <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <select
                aria-label={t('organizations.switcherLabel')}
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                value={currentOrganization?.organization._id ?? ''}
                onChange={(event) => {
                  const next = organizations.find(({ organization }) => organization._id === event.target.value);
                  if (next !== undefined) selectOrganization(next);
                }}
              >
                <option value="" disabled>
                  {t('organizations.chooseOrganization')}
                </option>
                {organizations.map(({ organization }) => {
                  return (
                    <option key={organization._id} value={organization._id}>
                      {organization.name}
                    </option>
                  );
                })}
              </select>
            </div>
            <LocaleSwitcher />
            <Button
              variant="ghost"
              size="icon"
              selected={pathname === `/${segment}/settings`}
              aria-label={t('nav.settings')}
              render={<Link href={`/${segment}/settings`} />}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
                <path d="m19.4 13.6 1.1.9-1.8 3.1-1.3-.5a7.7 7.7 0 0 1-1.6.9l-.2 1.4h-3.6l-.2-1.4a7.7 7.7 0 0 1-1.6-.9l-1.3.5-1.8-3.1 1.1-.9a7 7 0 0 1 0-1.8l-1.1-.9L9 7l1.3.5a7.7 7.7 0 0 1 1.6-.9l.2-1.4h3.6l.2 1.4a7.7 7.7 0 0 1 1.6.9l1.3-.5 1.8 3.1-1.1.9a7 7 0 0 1 0 1.8Z" />
              </svg>
            </Button>
            <UserButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[88rem] px-6 py-8 pb-12">
        {currentOrganization === null ? (
          <Panel emphasis="focal">
            <PanelBody>
              <EmptyState title={t('organizations.chooseOrganization')} />
            </PanelBody>
          </Panel>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
