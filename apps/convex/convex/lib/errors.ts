import { ConvexError } from 'convex/values';

const NOT_FOUND_OR_INACCESSIBLE = 'Not found or inaccessible';
const UNAUTHENTICATED = 'Unauthenticated';
const CONFLICT = 'Conflict';

/** Throws a generic error so authorization failures never disclose existence (I9). */
export function notFoundOrInaccessible(): never {
  throw new ConvexError(NOT_FOUND_OR_INACCESSIBLE);
}

/** Throws the stable error used when an operation requires an authenticated identity. */
export function unauthenticated(): never {
  throw new ConvexError(UNAUTHENTICATED);
}

/** Throws a generic conflict error without disclosing the conflicting record. */
export function conflict(): never {
  throw new ConvexError(CONFLICT);
}

/** Rejects the caller's own malformed input; the message may be specific (no I9 concern). */
export function invalidInput(message: string): never {
  throw new ConvexError(message);
}
