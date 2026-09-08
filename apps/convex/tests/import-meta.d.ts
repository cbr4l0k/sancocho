// Minimal typing for vitest's (vite's) import.meta.glob, used to hand convex-test
// the function modules. Avoids depending on vite/client type resolution under bun.
interface ImportMeta {
  glob(
    pattern: string | readonly string[],
  ): Record<string, () => Promise<unknown>>;
  /**
   * The eager `?raw` form, used by `providerAccess.test.ts` to read the backend
   * sources as text and assert the structural rule that exactly one helper
   * resolves both principal arms. Vite inlines the file contents at transform
   * time, so this works under the `edge-runtime` test environment, which has no
   * `node:fs`.
   */
  glob(
    pattern: string | readonly string[],
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, string>;
}
