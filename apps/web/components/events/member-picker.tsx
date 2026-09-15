'use client';

import { usePaginatedQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { useTranslations } from 'next-intl';

import { api } from '@priamo/convex/api';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type OrganizationId = FunctionArgs<typeof api.organizations.queries.listMembers>['organizationId'];
type UserId = FunctionArgs<typeof api.organizations.mutations.addMember>['userId'];

export function MemberPicker({
  organizationId,
  value,
  onChange,
  disabled = false,
}: {
  organizationId: OrganizationId;
  value: UserId | undefined;
  onChange: (userId: UserId) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const members = usePaginatedQuery(api.organizations.queries.listMembers, { organizationId }, { initialNumItems: 50 });
  return <div className="flex flex-col gap-3">
    {members.status === 'Exhausted' && members.results.length === 0 ? (
      <EmptyState title={t('empty.noRecords')} />
    ) : <div className="flex flex-wrap gap-2">
      {members.results.map(({ user }) => <Button
        key={user._id}
        type="button"
        size="sm"
        selected={value === user._id}
        disabled={disabled}
        onClick={() => onChange(user._id)}
      >{user.name ?? user.email ?? t('events.notSet')}</Button>)}
    </div>}
    {members.status === 'CanLoadMore' ? <Button type="button" size="sm" onClick={() => members.loadMore(50)}>{t('table.loadMore')}</Button> : null}
  </div>;
}
