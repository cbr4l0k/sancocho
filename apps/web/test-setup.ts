/**
 * The zone pin, where a bare `bun test` cannot drop it.
 *
 * `workbook-cells.ts` reads a parser `Date` with the UTC getters deliberately, and
 * under a UTC runner swapping them for the local getters passes every test — the
 * guard is inert in the environment where it runs. Only a non-zero offset tells them
 * apart. `es-CO` is the default locale, so Bogotá is both the honest zone and the one
 * whose operators would otherwise have seen every imported date shifted a day back.
 *
 * The `test` script also sets `TZ`; this preload is what makes `bun test` (no `run`)
 * and an editor's test runner agree with it. See deviation 34 in docs/deviations.md.
 */
process.env.TZ = 'America/Bogota';
