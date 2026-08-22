# Web chat — decisions for #32

The decision record for the chat surface: what state persists, the `ChatBackend`
contract, and the boundary with #33 (proposal cards). Read `docs/web-design.md` first —
this document only covers what is specific to chat.

---

## 1. Persistence: in-memory, for this issue

**Decision: the conversation lives in React state for the browser session only. It is
lost on reload, tab close, or navigation away from and back to `/chat`.**

Why, in order of weight:

1. **Persisting it is a backend issue, not a frontend one**, exactly as #32 calls out.
   A durable conversation needs a new Convex table, tenant scoping (I1: every row must
   prove `identity → app user → org membership`), pagination for a growing per-user
   history (I6), and a decision about whether conversation content belongs in the audit
   log. None of that exists yet, and building it silently inside a UI-only issue would
   smuggle a schema decision into a ticket that explicitly excludes one.
2. **Nothing here is authoritative data.** Per #33, the assistant never writes directly;
   a proposal only becomes a real Recipe or Service once a human accepts it into the
   existing form and submits the existing mutation. The conversation transcript itself
   is scratch space for getting there, not a record Sancocho needs to keep — the actual
   product artifacts (recipes, services) are what get persisted, through the paths that
   already persist them.
3. **In-memory is honest about what the stub is.** #32 explicitly forbids network calls
   and model-shaped code in the bundle. A conversation that survives reload would imply
   a durability guarantee the stub cannot back up with anything real.

Consequence for whoever opens the persistence follow-up issue: it needs its own table
(likely `chatConversations` + `chatTurns`, mirroring the `ChatTurn`/`ChatProposal` shapes
below), org + user scoping, and a decision on whether accepted-vs-discarded proposal
outcomes belong in the audit log (`docs/audit.md`). This document deliberately does not
design that table — that is the follow-up issue's job, not this one's.

State lives in `components/chat/use-chat-conversation.ts`, wired to the pure reducer in
`apps/web/lib/chat-conversation.ts`. Reloading `/chat` starts a new, empty conversation.

---

## 2. Locale: the assistant replies in the console's active locale

**Decision: `ChatBackend.sendMessage` takes the console's active `CanonicalLocale` as
part of its request, and the reply comes back in that language — independent of
whatever language the operator typed in.**

This is part of the interface from day one, per #32's explicit instruction, so a real
model integration does not retrofit a signature it already depends on:

```ts
export interface ChatSendMessageRequest {
  readonly history: readonly ChatTurn[];
  readonly text: string;
  readonly locale: CanonicalLocale;
}

export interface ChatBackend {
  sendMessage(request: ChatSendMessageRequest): Promise<ChatTurn>;
}
```

The stub cannot understand what language the operator typed in — it has no NLU — so it
always replies in `locale`. A real model can do better (detect the operator's language
from `text` and decide whether to match it or the console locale), but that is a later
integration's design decision, not this issue's; the contract only fixes what the console
tells the backend, not what the backend must do with it.

**Note for whoever wires a real model** (also called out in #33): a user prompting in
Spanish will get Spanish-labeled proposals, and those labels are tenant-authored content
that gets stored and rendered exactly as produced — never translated on the way into a
form. That is consistent with the rest of the console (recipe/field/project names are
never translated) but easy to mistake for a bug the first time someone sees it.

---

## 3. The `ChatBackend` seam

`apps/web/lib/chat-backend.ts` is the only file a real integration needs to change.
Every component depends on the `ChatBackend` interface, never on
`createStubChatBackend` — `ChatSurface` takes an optional `backend` prop that defaults to
the stub, so swapping implementations is a prop, not a refactor:

```ts
export interface ChatTurn {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: number;
  readonly status: 'complete' | 'error';
  readonly proposals?: readonly ChatProposal[];
}

export interface ChatBackend {
  sendMessage(request: ChatSendMessageRequest): Promise<ChatTurn>;
}
```

No implementation of this interface may make a network call, read model configuration,
or hold an API key — out of scope until a later integration issue (prompting, model
selection, tool definitions, streaming transport, cost handling all stay unopened here,
per #32).

The stub (`createStubChatBackend`) cycles deterministically through an in-memory bank of
canned turns per locale — no randomness, so the same sequence of calls always produces
the same sequence of replies. Sending the exact message `"error"` (any case, any
surrounding whitespace) always rejects, which is how the message list's error turn is
exercised without a flaky stub.

---

## 4. Proposal payloads: provisional shapes, not #33's types

The canned bank includes at least one turn per proposal kind (`recipe`, `service`) and
covers every review state #33 will need a card for: `valid`, `needsResolution` (an
unresolved reference — an unknown location, an archived field), and `invalid` (failed
validation, e.g. a non-`lowerCamelCase` key or a duplicate field key).

`ChatProposal` and friends in `lib/chat-backend.ts` are marked provisional in their own
doc comment. **Issue #33 owns the canonical version**: types derived from the backend
validators and published in `packages/shared` so they cannot drift, plus the real
proposal card (expandable detail view, per-proposal Accept/Discard, gap resolution).
This issue's `ChatProposalPreview` component
(`components/chat/chat-proposal-preview.tsx`) is deliberately a read-only, neutral
summary — proof that a realistic typed payload flows from backend to UI — and not a
preview of #33's eventual design.

`ChatRecipeProposalField.dataType` reuses the backend's own `FieldDataType` union rather
than inventing a parallel vocabulary, and the preview reuses the existing
`fields.dataTypes` catalogue entries for its labels instead of adding new ones.

---

## 5. Streaming-style rendering, without a real streaming transport

#32 asks for message-list rendering that will not need a re-layout once a real streaming
transport exists. The stub cannot stream — it resolves with a complete `ChatTurn` — so
the incremental effect is produced client-side: `useChatConversation` reveals an
assistant turn's `text` a chunk at a time via `setInterval`, tracked as `revealedLength`
on a UI-only `ChatDisplayTurn` (`lib/chat-conversation.ts`). The reveal loop and its pure
step math (`nextRevealedLength`, `revealStep`) are unit-tested directly; the interval
plumbing lives only in the hook.

`@shadcn/message-scroller` (via `@shadcn/react`) is what makes this safe: its stick-to-
bottom viewport keeps the transcript pinned to the growing message instead of fighting
the scroll position on every reveal tick, which is the actual reason a later real
integration will not need to re-layout this surface.

User turns and the synthesized error turn are always fully revealed immediately — there
is nothing to stream for text the operator just typed, or for a failure.

---

## 6. Motion budget

`docs/web-design.md` §9 caps the whole system at two animations. The in-flight indicator
(`components/chat/chat-in-flight-indicator.tsx`) reuses `sc-breathe` — the same halo
already used for an in-progress status marker — instead of adding a third animation for
a "typing" dots effect.

---

## 7. Composer: hand-rolled, not `@shadcn/input-group`

`@shadcn/input-group` was evaluated (`bunx shadcn search @shadcn -q input`) and not
installed. Its markup is built on shadcn's own `Input`/`Textarea` primitives and a large
set of `dark:`/ring/opacity utility classes tied to that project's token names
(`--ring`, `--input`, …), none of which exist in our token system (`--sc-*`). Re-skinning
it would mean rewriting nearly every class for a control that is, in the end, one
textarea and one button. `components/chat/chat-composer.tsx` follows the same shape as
`FieldControl` (`components/ui/field.tsx`) instead: a plain grow-to-fit `<textarea>` on
our tokens plus the existing `Button` primitive.

`@shadcn/message` and `@shadcn/message-scroller` **were** installed, per #32's
instruction — both are simple, dependency-light presentational primitives (or, for the
scroller, a thin wrapper around real `@shadcn/react` scroll behavior) that were
straightforward to re-skin in place, unlike `input-group`.
