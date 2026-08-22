import { expect, test } from 'bun:test';

import type { ChatTurn } from './chat-backend';
import {
  chatConversationReducer,
  createAssistantDisplayTurn,
  createErrorDisplayTurn,
  createUserDisplayTurn,
  initialChatConversationState,
  nextRevealedLength,
  revealStep,
  toChatTurn,
} from './chat-conversation';

test('a user turn is fully revealed and marks the conversation pending', () => {
  const turn = createUserDisplayTurn('user-1', 'Hola', 1_000);
  const state = chatConversationReducer(initialChatConversationState, { type: 'user-message-sent', turn });

  expect(state.turns).toEqual([turn]);
  expect(turn.revealedLength).toBe('Hola'.length);
  expect(state.pending).toBe(true);
});

test('an assistant reply starts fully unrevealed and clears pending', () => {
  const backendTurn: ChatTurn = { id: 'a-1', role: 'assistant', text: 'Claro, dime más.', createdAt: 2_000, status: 'complete' };
  const displayTurn = createAssistantDisplayTurn(backendTurn);

  const afterUser = chatConversationReducer(initialChatConversationState, {
    type: 'user-message-sent',
    turn: createUserDisplayTurn('user-1', 'Hola', 1_000),
  });
  const afterReply = chatConversationReducer(afterUser, { type: 'assistant-reply-started', turn: displayTurn });

  expect(displayTurn.revealedLength).toBe(0);
  expect(afterReply.turns).toHaveLength(2);
  expect(afterReply.pending).toBe(false);
});

test('an error turn is fully revealed immediately and clears pending', () => {
  const errorTurn = createErrorDisplayTurn('err-1', 3_000, 'Algo salió mal.');

  const state = chatConversationReducer(
    { turns: [], pending: true },
    { type: 'assistant-reply-failed', turn: errorTurn },
  );

  expect(errorTurn.status).toBe('error');
  expect(errorTurn.revealedLength).toBe('Algo salió mal.'.length);
  expect(state.pending).toBe(false);
  expect(state.turns).toEqual([errorTurn]);
});

test('reveal progress only updates the matching turn, leaving others untouched', () => {
  const first = createAssistantDisplayTurn({ id: 'a-1', role: 'assistant', text: 'Primero', createdAt: 1, status: 'complete' });
  const second = createAssistantDisplayTurn({ id: 'a-2', role: 'assistant', text: 'Segundo', createdAt: 2, status: 'complete' });
  const seeded = { turns: [first, second], pending: false };

  const next = chatConversationReducer(seeded, {
    type: 'assistant-reveal-progressed',
    turnId: 'a-2',
    revealedLength: 3,
  });

  const updatedFirst = next.turns.find((turn) => turn.id === 'a-1');
  const updatedSecond = next.turns.find((turn) => turn.id === 'a-2');
  expect(updatedFirst?.revealedLength).toBe(0);
  expect(updatedSecond?.revealedLength).toBe(3);
});

test('toChatTurn strips the UI-only reveal state', () => {
  const displayTurn = createUserDisplayTurn('user-1', 'Hola', 1_000);

  const turn = toChatTurn(displayTurn);

  expect(turn).toEqual({ id: 'user-1', role: 'user', text: 'Hola', createdAt: 1_000, status: 'complete' });
  expect(Object.hasOwn(turn, 'revealedLength')).toBe(false);
});

test('nextRevealedLength never exceeds the total and a non-positive step reveals everything', () => {
  expect(nextRevealedLength(0, 10, 4)).toBe(4);
  expect(nextRevealedLength(8, 10, 4)).toBe(10);
  expect(nextRevealedLength(0, 10, 0)).toBe(10);
  expect(nextRevealedLength(0, 10, -1)).toBe(10);
});

test('revealStep sizes the chunk so a longer reply does not take more ticks', () => {
  expect(revealStep(0)).toBe(1);
  expect(revealStep(24, 24)).toBe(1);
  expect(revealStep(48, 24)).toBe(2);
});
