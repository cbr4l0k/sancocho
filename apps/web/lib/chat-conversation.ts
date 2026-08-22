import type { ChatTurn } from '@/lib/chat-backend';

/**
 * The session's conversation state, plus reducer and pure helpers. Kept
 * framework-free so it is testable without rendering anything; `components/chat`
 * wires this to `useReducer` and the `ChatBackend` side effects.
 */

/**
 * A turn as displayed. Extends `ChatTurn` with `revealedLength`, which drives
 * the streaming-style incremental rendering required by #32 so a later real
 * streaming transport needs no re-layout: assistant text is revealed a chunk
 * at a time instead of appearing all at once. User turns and error turns are
 * always fully revealed — only a canned assistant reply streams in.
 */
export interface ChatDisplayTurn extends ChatTurn {
  readonly revealedLength: number;
}

export interface ChatConversationState {
  readonly turns: readonly ChatDisplayTurn[];
  /** True while a `ChatBackend.sendMessage` call is in flight. */
  readonly pending: boolean;
}

export const initialChatConversationState: ChatConversationState = {
  turns: [],
  pending: false,
};

export type ChatConversationAction =
  | { readonly type: 'user-message-sent'; readonly turn: ChatDisplayTurn }
  | { readonly type: 'assistant-reply-started'; readonly turn: ChatDisplayTurn }
  | { readonly type: 'assistant-reply-failed'; readonly turn: ChatDisplayTurn }
  | { readonly type: 'assistant-reveal-progressed'; readonly turnId: string; readonly revealedLength: number };

export function chatConversationReducer(
  state: ChatConversationState,
  action: ChatConversationAction,
): ChatConversationState {
  switch (action.type) {
    case 'user-message-sent':
      return { turns: [...state.turns, action.turn], pending: true };
    case 'assistant-reply-started':
      return { turns: [...state.turns, action.turn], pending: false };
    case 'assistant-reply-failed':
      return { turns: [...state.turns, action.turn], pending: false };
    case 'assistant-reveal-progressed':
      return {
        ...state,
        turns: state.turns.map((turn) =>
          turn.id === action.turnId ? { ...turn, revealedLength: action.revealedLength } : turn,
        ),
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function createUserDisplayTurn(id: string, text: string, createdAt: number): ChatDisplayTurn {
  return { id, role: 'user', text, createdAt, status: 'complete', revealedLength: text.length };
}

/** An assistant turn starts fully unrevealed; the reveal loop grows it. */
export function createAssistantDisplayTurn(turn: ChatTurn): ChatDisplayTurn {
  return { ...turn, revealedLength: 0 };
}

/** An error turn appears in full immediately — there is nothing to stream. */
export function createErrorDisplayTurn(id: string, createdAt: number, text: string): ChatDisplayTurn {
  return { id, role: 'assistant', text, createdAt, status: 'error', revealedLength: text.length };
}

/** Strips the UI-only reveal state before a turn is sent back to `ChatBackend` as history. */
export function toChatTurn(turn: ChatDisplayTurn): ChatTurn {
  const { revealedLength: _revealedLength, ...rest } = turn;
  return rest;
}

/**
 * The next reveal length for one tick of the streaming-style reveal loop.
 * Never exceeds `total`, and a non-positive `step` reveals everything at once
 * rather than looping forever.
 */
export function nextRevealedLength(current: number, total: number, step: number): number {
  if (step <= 0) return total;
  return Math.min(current + step, total);
}

/**
 * Chunk size for one reveal tick, sized so any canned turn finishes in roughly
 * the same number of ticks regardless of its length.
 */
export function revealStep(totalLength: number, ticks = 24): number {
  return Math.max(1, Math.ceil(totalLength / ticks));
}
