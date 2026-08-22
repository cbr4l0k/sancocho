# Search and filtered tenant lists

Tenant lists keep filtering inside their cursor-paginated Convex query (I6), rather than
filtering already loaded rows in the console. The query always begins in the caller's
already-authorized organization scope (I1/I9); filtering is never a post-hoc pass over a
broader result set.

## Normalized search text

Locations and field definitions store a server-derived `searchText` column (I4), and public
queries accept only the search term—not a client-supplied value for that column. The stored
text and query are normalized together: Convex tokenizes case and punctuation, but does not
fold diacritics. In the default `es-CO` locale, a search for `medellin` would therefore miss
`Medellín` without normalization. For fields, the one normalized column also combines the
tenant-authored `key` and `label`. This makes `convex-test`'s simpler tokenizer agree with
production closely enough to test the same contract.

`searchText` remains `v.optional` only to accommodate rows that predate the column. The
server creates and updates it; `seed/mutations.ts:backfillSearchText` repairs legacy rows.

We rejected the cheaper indexed prefix match proposed during the issue: it only matches the
start of a name, so `marriott` would silently fail to find `Hotel Marriott`. Removing silent
absences is the purpose of this work. A Convex search index matches terms throughout the
normalized text instead.

## Accepted limits

Convex search returns at most 1024 results. It also returns relevance order, not creation
order, so searched lists intentionally sort differently from unsearched lists. Those limits
are preferable to pretending an incomplete prefix match is a complete tenant list.
