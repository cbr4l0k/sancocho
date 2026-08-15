import { ConvexError } from 'convex/values';

export type ConvexErrorPresentation = 'notFound' | 'unauthenticated' | 'conflict' | 'generic';

/**
 * The one client-side interpretation of Convex's stable error contract.
 * It reads structured `ConvexError.data`, never a rendered stack/message.
 */
export function presentConvexError(error: unknown): ConvexErrorPresentation {
  if (!(error instanceof ConvexError)) return 'generic';

  switch (error.data) {
    case 'Not found or inaccessible':
      return 'notFound';
    case 'Unauthenticated':
      return 'unauthenticated';
    case 'Conflict':
      return 'conflict';
    default:
      return 'generic';
  }
}

export function errorMessageKey(presentation: ConvexErrorPresentation): 'errors.notFound' | 'errors.generic' {
  return presentation === 'notFound' ? 'errors.notFound' : 'errors.generic';
}
