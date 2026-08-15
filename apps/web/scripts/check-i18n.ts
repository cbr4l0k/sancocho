import { enUS, esCO } from '../i18n/messages';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leafKeys(value: unknown, prefix = ''): Set<string> {
  if (!isRecord(value)) return new Set([prefix]);
  return Object.entries(value).reduce((keys, [key, child]) => {
    for (const leaf of leafKeys(child, prefix === '' ? key : `${prefix}.${key}`)) keys.add(leaf);
    return keys;
  }, new Set<string>());
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((key) => !right.has(key)).sort();
}

const spanishKeys = leafKeys(esCO);
const englishKeys = leafKeys(enUS);
const missingInEnglish = difference(spanishKeys, englishKeys);
const missingInSpanish = difference(englishKeys, spanishKeys);

if (missingInEnglish.length > 0 || missingInSpanish.length > 0) {
  if (missingInEnglish.length > 0) console.error(`Missing in en-US: ${missingInEnglish.join(', ')}`);
  if (missingInSpanish.length > 0) console.error(`Missing in es-CO: ${missingInSpanish.join(', ')}`);
  process.exit(1);
}

console.log(`i18n catalogue parity passed (${spanishKeys.size} message keys).`);
