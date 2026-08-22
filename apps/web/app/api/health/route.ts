/**
 * Liveness probe for the container platform. `/` answers with a 307 to the
 * negotiated locale, which health checks report as a redirect rather than a
 * healthy service, so the probe gets its own unauthenticated 200.
 *
 * The proxy matcher excludes `/api`, so no locale rewrite applies here.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
