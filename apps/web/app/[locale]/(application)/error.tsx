'use client';

import { useTranslations } from 'next-intl';

import { EmptyState, UnavailableState } from '@/components/ui/empty-state';
import { Panel, PanelBody } from '@/components/ui/panel';
import { errorMessageKey, presentConvexError } from '@/lib/convex-errors';

export default function ApplicationError({
  error,
}: Readonly<{ error: Error & { digest?: string | undefined }; reset: () => void }>) {
  const t = useTranslations();
  const presentation = presentConvexError(error);
  return (
    <Panel emphasis="focal">
      <PanelBody>
        {presentation === 'errors.notFound' ? (
          <UnavailableState />
        ) : (
          <EmptyState tone="unavailable" title={t(errorMessageKey(presentation))} />
        )}
      </PanelBody>
    </Panel>
  );
}
