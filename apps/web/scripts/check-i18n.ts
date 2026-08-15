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

function dottedKeys(value: unknown, prefix = ''): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [key.includes('.') ? path : [], ...dottedKeys(child, path)].flat();
  });
}

const spanishKeys = leafKeys(esCO);
const englishKeys = leafKeys(enUS);
const missingInEnglish = difference(spanishKeys, englishKeys);
const missingInSpanish = difference(englishKeys, spanishKeys);
const dottedSpanishKeys = dottedKeys(esCO);
const dottedEnglishKeys = dottedKeys(enUS);

if (dottedSpanishKeys.length > 0 || dottedEnglishKeys.length > 0) {
  if (dottedSpanishKeys.length > 0) console.error(`Invalid dotted message keys in es-CO: ${dottedSpanishKeys.join(', ')}`);
  if (dottedEnglishKeys.length > 0) console.error(`Invalid dotted message keys in en-US: ${dottedEnglishKeys.join(', ')}`);
  process.exit(1);
}

if (missingInEnglish.length > 0 || missingInSpanish.length > 0) {
  if (missingInEnglish.length > 0) console.error(`Missing in en-US: ${missingInEnglish.join(', ')}`);
  if (missingInSpanish.length > 0) console.error(`Missing in es-CO: ${missingInSpanish.join(', ')}`);
  process.exit(1);
}

console.log(`i18n catalogue parity passed (${spanishKeys.size} message keys).`);
