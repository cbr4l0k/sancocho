'use client';

import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { api } from '@priamo/convex/api';

type FieldDefinition = FunctionReturnType<
  typeof api.fields.queries.getFieldDefinitionsByIds
>[number];
type FieldDefinitionId = FunctionArgs<
  typeof api.fields.queries.getFieldDefinitionsByIds
>['fieldDefinitionIds'][number];
type FieldDefinitionReference = { fieldDefinitionId: FieldDefinitionId };
type OrganizationId = FunctionArgs<
  typeof api.fields.queries.getFieldDefinitionsByIds
>['organizationId'];

export function useFieldDefinitionIndex(
  organizationId: OrganizationId | undefined,
  fields: readonly FieldDefinitionReference[],
): ReadonlyMap<string, FieldDefinition> | undefined {
  const fieldDefinitionIds = useMemo(
    // Stable arguments prevent useQuery from refetching when source row order changes.
    () => [...new Set(fields.map((field) => field.fieldDefinitionId))].sort(),
    [fields],
  );
  const skip = organizationId === undefined || fieldDefinitionIds.length === 0;
  const definitions = useQuery(
    api.fields.queries.getFieldDefinitionsByIds,
    organizationId === undefined || fieldDefinitionIds.length === 0
      ? 'skip'
      : { organizationId, fieldDefinitionIds },
  );

  return useMemo(() => {
    if (skip) return new Map<string, FieldDefinition>();
    if (definitions === undefined) return undefined;
    return new Map(definitions.map((field) => [field._id, field]));
  }, [definitions, skip]);
}
