'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

import type { CanonicalLocale } from '@/i18n/locales';
import type { ChatBackend } from '@/lib/chat-backend';
import {
  chatConversationReducer,
  createAssistantDisplayTurn,
  createErrorDisplayTurn,
  createUserDisplayTurn,
  initialChatConversationState,
  nextRevealedLength,
  revealStep,
  toChatTurn,
} from '@/lib/chat-conversation';

/** One reveal tick. Streaming-style rendering only — no real transport (out of scope, see #32). */
const REVEAL_TICK_MS = 24;

/**
 * Wires the pure reducer in `lib/chat-conversation.ts` to a `ChatBackend` and
 * a `setInterval`-driven reveal loop. All conversation state lives here, for
 * the session only — see `docs/web-chat.md` for the persistence decision.
 */
export function useChatConversation(backend: ChatBackend, locale: CanonicalLocale, errorTurnText: string) {
  const [state, dispatch] = useReducer(chatConversationReducer, initialChatConversationState);
  const revealIntervals = useRef(new Set<ReturnType<typeof setInterval>>());

  useEffect(() => {
    const intervals = revealIntervals.current;
    return () => {
      for (const interval of intervals) clearInterval(interval);
      intervals.clear();
    };
  }, []);

  const revealTurn = useCallback((turnId: string, totalLength: number) => {
    if (totalLength === 0) return;
    const step = revealStep(totalLength);
    let revealed = 0;
    const interval = setInterval(() => {
      revealed = nextRevealedLength(revealed, totalLength, step);
      dispatch({ type: 'assistant-reveal-progressed', turnId, revealedLength: revealed });
      if (revealed >= totalLength) {
        clearInterval(interval);
        revealIntervals.current.delete(interval);
      }
    }, REVEAL_TICK_MS);
    revealIntervals.current.add(interval);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const userTurn = createUserDisplayTurn(crypto.randomUUID(), text, Date.now());
      const history = [...state.turns, userTurn].map(toChatTurn);
      dispatch({ type: 'user-message-sent', turn: userTurn });

      try {
        const reply = await backend.sendMessage({ history, text, locale });
        const displayTurn = createAssistantDisplayTurn(reply);
        dispatch({ type: 'assistant-reply-started', turn: displayTurn });
        revealTurn(displayTurn.id, displayTurn.text.length);
      } catch {
        const errorTurn = createErrorDisplayTurn(crypto.randomUUID(), Date.now(), errorTurnText);
        dispatch({ type: 'assistant-reply-failed', turn: errorTurn });
      }
    },
    [backend, locale, errorTurnText, revealTurn, state.turns],
  );

  return { turns: state.turns, pending: state.pending, sendMessage };
}
