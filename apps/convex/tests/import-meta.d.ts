// Minimal typing for vitest's (vite's) import.meta.glob, used to hand convex-test
// the function modules. Avoids depending on vite/client type resolution under bun.
interface ImportMeta {
  glob(
    pattern: string | readonly string[],
  ): Record<string, () => Promise<unknown>>;
}
