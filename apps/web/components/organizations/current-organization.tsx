'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { api } from '@priamo/convex/api';
import type { FunctionReturnType } from 'convex/server';

const organizationCookieName = 'priamo_organization';

export type OrganizationMembership = FunctionReturnType<typeof api.organizations.queries.listMyOrganizations>[number];
type OrganizationId = FunctionReturnType<typeof api.organizations.mutations.createOrganization>;

type CurrentOrganizationContextValue = {
  currentOrganization: OrganizationMembership | null;
  organizations: readonly OrganizationMembership[];
  selectOrganization: (organization: OrganizationMembership) => void;
  selectCreatedOrganization: (organizationId: OrganizationId) => void;
};

const CurrentOrganizationContext = createContext<CurrentOrganizationContextValue | null>(null);

function readPersistedOrganizationId(): string | null {
  const cookie = document.cookie.split('; ').find((entry) => entry.startsWith(`${organizationCookieName}=`));
  return cookie === undefined ? null : decodeURIComponent(cookie.slice(organizationCookieName.length + 1));
}

function persistOrganizationId(organizationId: OrganizationId): void {
  document.cookie = `${organizationCookieName}=${encodeURIComponent(organizationId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function CurrentOrganizationProvider({
  organizations,
  children,
}: {
  organizations: readonly OrganizationMembership[];
  children: ReactNode;
}) {
  const [persistedId, setPersistedId] = useState<string | null>(() =>
    typeof document === 'undefined' ? null : readPersistedOrganizationId(),
  );

  const currentOrganization = useMemo(
    () => organizations.find(({ organization }) => organization._id === persistedId) ?? null,
    [organizations, persistedId],
  );

  const value = useMemo<CurrentOrganizationContextValue>(
    () => ({
      currentOrganization,
      organizations,
      selectOrganization: (organization) => {
        persistOrganizationId(organization.organization._id);
        setPersistedId(organization.organization._id);
      },
      selectCreatedOrganization: (organizationId) => {
        persistOrganizationId(organizationId);
        setPersistedId(organizationId);
      },
    }),
    [currentOrganization, organizations],
  );

  return <CurrentOrganizationContext.Provider value={value}>{children}</CurrentOrganizationContext.Provider>;
}

export function useCurrentOrganization(): CurrentOrganizationContextValue {
  const context = useContext(CurrentOrganizationContext);
  if (context === null) throw new Error('useCurrentOrganization must be used inside CurrentOrganizationProvider');
  return context;
}
