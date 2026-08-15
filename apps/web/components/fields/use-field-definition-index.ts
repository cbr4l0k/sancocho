'use client';

import { useEffect } from 'react';
import { usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import { api } from '@sancocho/convex/api';

type FieldDefinition = FunctionReturnType<
  typeof api.fields.queries.listFieldDefinitions
>['page'][number];

const maxIndexPages = 4;

/**
 * A bounded convenience index for read-only recipe composition. It intentionally
 * stops after a few pages: a label lookup must never become an unbounded tenant read.
 */
export function useFieldDefinitionIndex(
  organizationId: FunctionArgs<typeof api.fields.queries.listFieldDefinitions>['organizationId'],
): ReadonlyMap<string, FieldDefinition> {
  const custom = usePaginatedQuery(
    api.fields.queries.listFieldDefinitions,
    { organizationId },
    { initialNumItems: 50 },
  );
  const builtins = usePaginatedQuery(
    api.fields.queries.listBuiltinFieldDefinitions,
    {},
    { initialNumItems: 50 },
  );

  useEffect(() => {
    if (custom.status === 'CanLoadMore' && custom.results.length < maxIndexPages * 50) {
      custom.loadMore(50);
    }
  }, [custom]);
  useEffect(() => {
    if (builtins.status === 'CanLoadMore' && builtins.results.length < maxIndexPages * 50) {
      builtins.loadMore(50);
    }
  }, [builtins]);

  return new Map([...custom.results, ...builtins.results].map((field) => [field._id, field]));
}
