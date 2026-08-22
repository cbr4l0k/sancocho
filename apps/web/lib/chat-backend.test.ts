import { expect, test } from 'bun:test';

import { ChatBackendError, createStubChatBackend, type ChatSendMessageRequest } from './chat-backend';

function request(overrides: Partial<ChatSendMessageRequest> = {}): ChatSendMessageRequest {
  return { history: [], text: 'Necesito un servicio de transporte.', locale: 'es-CO', ...overrides };
}

test('returns a canned assistant turn stamped with the injected clock and id', async () => {
  const backend = createStubChatBackend({ now: () => 1_700_000_000_000, createId: () => 'turn-1' });

  const turn = await backend.sendMessage(request());

  expect(turn.id).toBe('turn-1');
  expect(turn.createdAt).toBe(1_700_000_000_000);
  expect(turn.role).toBe('assistant');
  expect(turn.status).toBe('complete');
});

test('replies in the requested locale', async () => {
  const backend = createStubChatBackend();

  const spanish = await backend.sendMessage(request({ locale: 'es-CO' }));
  const english = await backend.sendMessage(request({ locale: 'en-US' }));

  // The two catalogues never share exact wording for the same canned scenario.
  expect(spanish.text).not.toBe(english.text);
});

test('cycles deterministically through the canned bank per backend instance', async () => {
  const backend = createStubChatBackend();

  const first = await backend.sendMessage(request());
  const second = await backend.sendMessage(request());
  const third = await backend.sendMessage(request());

  expect(first.text).not.toBe(second.text);
  expect(second.text).not.toBe(third.text);

  // A fresh instance starts the cycle over, independent of any other instance.
  const anotherBackend = createStubChatBackend();
  const restarted = await anotherBackend.sendMessage(request());
  expect(restarted.text).toBe(first.text);
});

test('includes at least one canned turn per proposal kind, covering every review status', async () => {
  const backend = createStubChatBackend();
  const seenKinds = new Set<string>();
  const seenStatuses = new Set<string>();

  for (let index = 0; index < 5; index += 1) {
    const turn = await backend.sendMessage(request());
    for (const proposal of turn.proposals ?? []) {
      seenKinds.add(proposal.kind);
      seenStatuses.add(proposal.status);
    }
  }

  expect(seenKinds.has('recipe')).toBe(true);
  expect(seenKinds.has('service')).toBe(true);
  expect(seenStatuses.has('valid')).toBe(true);
  expect(seenStatuses.has('needsResolution')).toBe(true);
  expect(seenStatuses.has('invalid')).toBe(true);
});

test('rejects with ChatBackendError on the error-trigger message, regardless of case or spacing', async () => {
  const backend = createStubChatBackend();

  await expect(backend.sendMessage(request({ text: '  Error  ' }))).rejects.toBeInstanceOf(ChatBackendError);
});

test('does not treat a message that merely mentions the trigger word as an error', async () => {
  const backend = createStubChatBackend();

  const turn = await backend.sendMessage(request({ text: 'I got an error yesterday, can you help?' }));

  expect(turn.status).toBe('complete');
});
