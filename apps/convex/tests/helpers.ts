// Tests live outside convex/, so convex-test needs the function modules globbed
// explicitly. The extglob pattern from the convex-test docs (`!(*.*.*)*.*s`)
// matches nothing under vitest 4's glob implementation; the array form with a
// negative `.d.ts` exclude is equivalent.
export const modules = import.meta.glob([
  '../convex/**/*.{js,ts}',
  '!../convex/**/*.d.ts',
]);
