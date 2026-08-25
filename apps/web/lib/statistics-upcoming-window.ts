/**
 * The upcoming-services window options offered in the console.
 *
 * The backend hard-caps the window at 31 days (`maxUpcomingWindowMs` in
 * `apps/convex/convex/statistics/model.ts`); 31 is included here as the
 * widest legal choice rather than inventing a different ceiling client-side.
 */
export const upcomingWindowOptions = [7, 14, 31] as const;
export type UpcomingWindowDays = (typeof upcomingWindowOptions)[number];
export const maxUpcomingWindowDays = 31;
export const defaultUpcomingWindowDays: UpcomingWindowDays = 14;
