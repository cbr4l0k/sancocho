'use client';

import { UserButton } from '@clerk/nextjs';
import { Authenticated, AuthLoading, Unauthenticated, useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { api } from '@sancocho/convex/api';

import { LocaleSwitcher } from '@/app/[locale]/locale-switcher';
import { CurrentOrganizationProvider, useCurrentOrganization } from '@/components/organizations/current-organization';
import { Bento, BentoItem } from '@/components/ui/bento';
import { Button } from '@/components/ui/button';
import { EmptyState, UnavailableState } from '@/components/ui/empty-state';
import { Field, FieldControl, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Panel, PanelBody, PanelBodyFlush, PanelDescription, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableLoadMore, TableRow, TableRowHeaderCell, TableSkeletonRows } from '@/components/ui/table';
import { errorMessageKey, presentConvexError, type ConvexErrorPresentation } from '@/lib/convex-errors';
import { roleLabelKey } from '@/lib/roles';
import { segmentForCanonicalLocale } from '@/i18n/locales';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-[88rem] flex-col gap-5 px-4 py-8 sm:px-6 lg:py-12">
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
      <Unauthenticated>
        <SignedOutScreen />
      </Unauthenticated>
      <Authenticated>
        <ProvisionedApplication />
      </Authenticated>
    </main>
  );
}

function LoadingScreen() {
  return <div aria-busy="true"><Skeleton className="h-7 w-52" /><SkeletonText className="mt-5 max-w-md" /></div>;
}

function SignedOutScreen() {
  const locale = useLocale();
  const t = useTranslations();

  return (
    <Panel emphasis="focal" className="mx-auto w-full max-w-xl">
      <PanelHeader><PanelTitle>{t('auth.signedOut')}</PanelTitle></PanelHeader>
      <PanelBody className="flex-row flex-wrap items-center">
        <Button variant="primary" render={<a href={`/${segmentForCanonicalLocale(locale)}/sign-in`} />}>{t('auth.signIn')}</Button>
        <Button variant="secondary" render={<a href={`/${segmentForCanonicalLocale(locale)}/sign-up`} />}>{t('auth.signUp')}</Button>
      </PanelBody>
    </Panel>
  );
}

function ProvisionedApplication() {
  const user = useQuery(api.auth.queries.getCurrentUser);
  const ensureUser = useMutation(api.auth.mutations.ensureUser);
  const requested = useRef(false);
  const router = useRouter();
  const locale = useLocale();
  const [error, setError] = useState<ConvexErrorPresentation | null>(null);

  useEffect(() => {
    if (user !== null || requested.current) return;
    requested.current = true;
    void ensureUser().catch((caught: unknown) => {
      const presentation = presentConvexError(caught);
      if (presentation === 'unauthenticated') {
        router.replace(`/${segmentForCanonicalLocale(locale)}/sign-in`);
        return;
      }
      setError(presentation);
    });
  }, [ensureUser, locale, router, user]);

  if (error !== null) return <ProvisioningError presentation={error} />;
  if (user === undefined || user === null) return <LoadingScreen />;

  return <OrganizationApplication />;
}

function ProvisioningError({ presentation }: { presentation: ConvexErrorPresentation }) {
  const t = useTranslations();
  if (presentation === 'notFound') return <UnavailableState />;
  return <EmptyState tone="unavailable" title={t(errorMessageKey(presentation))} />;
}

function OrganizationApplication() {
  const organizations = useQuery(api.organizations.queries.listMyOrganizations);
  if (organizations === undefined) return <LoadingScreen />;

  return (
    <CurrentOrganizationProvider organizations={organizations}>
      <OrganizationWorkspace />
    </CurrentOrganizationProvider>
  );
}

function OrganizationWorkspace() {
  const { currentOrganization, organizations, selectOrganization } = useCurrentOrganization();
  const t = useTranslations();

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-xl font-extrabold text-ink">{t('organizations.title')}</h1></div>
        <div className="flex flex-wrap items-center gap-3"><LocaleSwitcher /><UserButton /></div>
      </header>
      {organizations.length === 0 ? <CreateOrganization /> : (
        <Bento>
          <BentoItem span={4}>
            <Panel className="h-full"><PanelHeader><PanelTitle>{t('organizations.title')}</PanelTitle></PanelHeader><PanelBody>
              <Field>
                <FieldLabel>{t('organizations.switcherLabel')}</FieldLabel>
                <FieldControl render={<select value={currentOrganization?.organization._id ?? ''} onChange={(event) => {
                  const next = organizations.find(({ organization }) => organization._id === event.target.value);
                  if (next !== undefined) selectOrganization(next);
                }} />}>
                  <option value="" disabled>{t('organizations.chooseOrganization')}</option>
                  {organizations.map(({ organization }) => <option key={organization._id} value={organization._id}>{organization.name}</option>)}
                </FieldControl>
              </Field>
            </PanelBody></Panel>
          </BentoItem>
          <BentoItem span={8}>{currentOrganization === null ? <PickOrganization /> : <MemberRoster />}</BentoItem>
        </Bento>
      )}
    </>
  );
}

function PickOrganization() {
  const t = useTranslations();
  return <Panel emphasis="focal" className="h-full"><PanelBody><EmptyState title={t('organizations.chooseOrganization')} /></PanelBody></Panel>;
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
    if (!slugPattern.test(slug) || slug.length < 3 || slug.length > 63) { setError('invalid'); return; }
    setSubmitting(true); setError(null);
    try {
      const organizationId = await createOrganization({ name, slug });
      selectCreatedOrganization(organizationId);
    } catch (caught: unknown) {
      setError(presentConvexError(caught));
    } finally { setSubmitting(false); }
  }

  const errorText = error === 'invalid' ? t('organizations.slugInvalid') : error === 'conflict' ? t('organizations.slugTaken') : error === null ? null : t(errorMessageKey(error));
  return (
    <Panel emphasis="focal" className="mx-auto w-full max-w-2xl"><PanelHeader><div><PanelTitle>{t('organizations.createTitle')}</PanelTitle><PanelDescription>{t('organizations.createDescription')}</PanelDescription></div></PanelHeader>
      <PanelBody><form className="flex flex-col gap-4" onSubmit={submit}>
        <Field><FieldLabel required>{t('organizations.nameLabel')}</FieldLabel><FieldControl required value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field invalid={error === 'invalid'}><FieldLabel required>{t('organizations.slugLabel')}</FieldLabel><FieldControl required value={slug} onChange={(event) => setSlug(event.target.value)} /><FieldDescription>{t('organizations.slugDescription')}</FieldDescription>{errorText === null ? null : <FieldError>{errorText}</FieldError>}</Field>
        <div><Button variant="primary" type="submit" disabled={submitting}>{t('organizations.createAction')}</Button></div>
      </form></PanelBody>
    </Panel>
  );
}

function MemberRoster() {
  const { currentOrganization } = useCurrentOrganization();
  const t = useTranslations();
  const members = usePaginatedQuery(api.organizations.queries.listMembers, currentOrganization === null ? 'skip' : { organizationId: currentOrganization.organization._id }, { initialNumItems: 25 });

  if (currentOrganization === null) return null;
  return <Panel className="h-full"><PanelHeader><div><PanelTitle>{t('organizations.rosterTitle')}</PanelTitle><PanelDescription>{t('organizations.rosterDescription')}</PanelDescription></div></PanelHeader><PanelBodyFlush>
    <Table><TableHead><TableRow><TableHeaderCell>{t('organizations.memberName')}</TableHeaderCell><TableHeaderCell>{t('organizations.memberEmail')}</TableHeaderCell><TableHeaderCell>{t('organizations.memberRole')}</TableHeaderCell></TableRow></TableHead>
      {members.status === 'LoadingFirstPage' ? <TableSkeletonRows columns={3} /> : <TableBody>{members.results.map(({ membership, user }) => <TableRow key={membership._id}><TableRowHeaderCell>{user.name ?? user.email ?? t('common.notAvailable')}</TableRowHeaderCell><TableCell>{user.email ?? t('common.notAvailable')}</TableCell><TableCell>{t(roleLabelKey[membership.role])}</TableCell></TableRow>)}</TableBody>}
    </Table>
    {members.status === 'Exhausted' && members.results.length === 0 ? <EmptyState title={t('empty.noRecords')} description={t('empty.noRecordsBody')} /> : <TableLoadMore status={members.status} loadedCount={members.results.length} onLoadMore={members.loadMore} />}
  </PanelBodyFlush></Panel>;
}
