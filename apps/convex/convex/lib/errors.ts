import { ConvexError } from 'convex/values';

const NOT_FOUND_OR_INACCESSIBLE = 'Not found or inaccessible';
const UNAUTHENTICATED = 'Unauthenticated';

/** Throws a generic error so authorization failures never disclose existence (I9). */
export function notFoundOrInaccessible(): never {
  throw new ConvexError(NOT_FOUND_OR_INACCESSIBLE);
}

/** Throws the stable error used when an operation requires an authenticated identity. */
export function unauthenticated(): never {
  throw new ConvexError(UNAUTHENTICATED);
}
