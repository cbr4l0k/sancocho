'use client';

import { useTranslations } from 'next-intl';

import { EmptyState, UnavailableState } from '@/components/ui/empty-state';
import { Panel, PanelBody } from '@/components/ui/panel';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';

/**
 * The recovery callback is `retry` in this version of Next, not `reset` — see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`.
 * Neither boundary invokes it (a not-found-or-inaccessible result is not
 * retryable, and offering a button that re-runs a refused read would suggest it
 * might succeed), but the declared shape should still describe what Next passes.
 * `(application)/error.tsx` predates this and still says `reset`.
 */
export default function PortalError({ error }: Readonly<{ error: Error & { digest?: string | undefined }; retry: () => void }>) {
  const t = useTranslations();
  const presentation = presentConvexError(error);
  return (
    <Panel emphasis="focal"><PanelBody>
      {presentation === 'errors.notFound'
        ? <UnavailableState />
        : <EmptyState tone="unavailable" title={t(errorMessageKey(presentation))} />}
    </PanelBody></Panel>
  );
}
