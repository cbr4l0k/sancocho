/**
 * Which service-kind-driven columns the Services table should offer.
 *
 * The table lists services from every project, so a page mixes service kinds: an
 * airport transfer carries a flight number and a terminal, a shuttle carries a
 * route and a passenger count. The table used to show four fixed columns and
 * nothing else, which meant the richer service kinds' data was invisible on the one
 * screen meant for scanning across them. This derives the union of the fields
 * the LOADED rows actually compose, so every service kind on screen can contribute
 * its own columns and the organiser decides which of them stay visible.
 *
 * Identity is the field definition's `key`, not its id: the same built-in field
 * composed by two different service kinds is one column, and `key` is the stable
 * half of the definition join (see `services/model.ts` `getService`).
 */
export type ServiceFieldColumnSource = { key: string; label: string; position: number };

export type ServiceFieldColumn = { key: string; label: string };

export function serviceFieldColumns(rows: readonly { fields: readonly ServiceFieldColumnSource[] }[]): ServiceFieldColumn[] {
  const seen = new Map<string, { label: string; position: number }>();
  for (const row of rows) {
    for (const field of row.fields) {
      const existing = seen.get(field.key);
      // Two service kinds can place the same field differently; the earliest position
      // any of them gives it decides where the column sits, so a column does
      // not jump around as pages with different service kind mixes load.
      if (existing === undefined || field.position < existing.position) {
        seen.set(field.key, { label: field.label, position: field.position });
      }
    }
  }
  return [...seen.entries()]
    .sort(([keyA, a], [keyB, b]) => a.position - b.position || a.label.localeCompare(b.label) || keyA.localeCompare(keyB))
    .map(([key, { label }]) => ({ key, label }));
}
