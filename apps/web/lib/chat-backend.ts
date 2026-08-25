import type { FieldDataType } from '@priamo/convex/validators';

import type { CanonicalLocale } from '@/i18n/locales';

/**
 * Proposal payload shapes for the chat surface (#32).
 *
 * These are deliberately provisional. Issue #33 owns the canonical proposal
 * types — derived from the backend validators and published in
 * `packages/shared` so they cannot drift — plus the proposal cards, the
 * Accept/Discard flow, and gap-resolution UI. The shapes below exist only so
 * the stub `ChatBackend` can emit a realistic payload for each proposal kind
 * and exercise the valid / needs-resolution / invalid states #33 will render
 * cards for. `dataType` reuses the backend's own `FieldDataType` union rather
 * than inventing a parallel vocabulary.
 */
export type ChatProposalStatus = 'valid' | 'needsResolution' | 'invalid';

export interface ChatRecipeProposalField {
  readonly key: string;
  readonly label: string;
  readonly dataType: FieldDataType;
  readonly required: boolean;
  /** Proposed as a brand-new Field Definition rather than reusing one. */
  readonly isNewFieldDefinition: boolean;
}

export interface ChatRecipeProposal {
  readonly kind: 'recipe';
  readonly id: string;
  readonly status: ChatProposalStatus;
  readonly recipeName: string;
  readonly recipeKey: string;
  readonly fields: readonly ChatRecipeProposalField[];
  /** Present only when `status === 'invalid'`. */
  readonly issues?: readonly string[];
}

export interface ChatServiceProposalValue {
  readonly key: string;
  readonly label: string;
  /** Rendered exactly as proposed; tenant-authored content is never translated. */
  readonly value: string;
}

export interface ChatServiceProposal {
  readonly kind: 'service';
  readonly id: string;
  readonly status: ChatProposalStatus;
  readonly projectName: string;
  readonly recipeName: string;
  readonly recipeVersionLabel: string;
  readonly values: readonly ChatServiceProposalValue[];
  /** Present only when `status === 'needsResolution'`: things that don't exist yet. */
  readonly gaps?: readonly string[];
  /** Present only when `status === 'invalid'`. */
  readonly issues?: readonly string[];
}

export type ChatProposal = ChatRecipeProposal | ChatServiceProposal;

export type ChatTurnRole = 'user' | 'assistant';
export type ChatTurnStatus = 'complete' | 'error';

/** One entry in the conversation, in the sense #33 calls "a turn". */
export interface ChatTurn {
  readonly id: string;
  readonly role: ChatTurnRole;
  readonly text: string;
  readonly createdAt: number;
  readonly status: ChatTurnStatus;
  readonly proposals?: readonly ChatProposal[];
}

export interface ChatSendMessageRequest {
  /** The conversation so far, oldest first, not including `text`. */
  readonly history: readonly ChatTurn[];
  /** The operator's newest message. */
  readonly text: string;
  /**
   * The console's active locale. Part of the contract from day one: the
   * assistant replies in the operator's active locale, so a real model later
   * receives this without the interface needing to change.
   */
  readonly locale: CanonicalLocale;
}

/**
 * The single seam a real model plugs into later. No implementation of this
 * interface may make a network call, read model configuration, or hold an
 * API key — that is explicitly out of scope until a later integration issue.
 * A component depends only on this interface, never on `createStubChatBackend`
 * directly, so swapping the stub for a real backend touches no component.
 */
export interface ChatBackend {
  sendMessage(request: ChatSendMessageRequest): Promise<ChatTurn>;
}

/** Thrown by the stub backend to exercise the message list's error turn. */
export class ChatBackendError extends Error {}

const ERROR_TRIGGER = 'error';

function isErrorTrigger(text: string): boolean {
  return text.trim().toLowerCase() === ERROR_TRIGGER;
}

type CannedTurn = Omit<ChatTurn, 'id' | 'createdAt'>;

/**
 * At least one canned turn per proposal kind in #33, in both catalogue
 * languages, plus a plain reply with no proposal and one canned turn per
 * proposal review state (`valid`, `needsResolution`, `invalid`) so #33 has
 * every card state to build against before a real model exists.
 */
const cannedTurns: Record<CanonicalLocale, readonly CannedTurn[]> = {
  'es-CO': [
    {
      role: 'assistant',
      status: 'complete',
      text:
        'Puedo ayudarte a armar una receta nueva, crear un servicio a partir de una receta ' +
        'publicada, o revisar lo que ya existe. Cuéntame qué necesitas y te propongo algo concreto.',
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'Con lo que describiste, arme esta receta. Revisa los campos propuestos.',
      proposals: [
        {
          kind: 'recipe',
          id: 'recipe-shuttle-valid',
          status: 'valid',
          recipeName: 'Transporte aeropuerto — grupo VIP',
          recipeKey: 'transporteAeropuertoVip',
          fields: [
            { key: 'flightNumber', label: 'Número de vuelo', dataType: 'text', required: true, isNewFieldDefinition: false },
            { key: 'passengerCount', label: 'Número de pasajeros', dataType: 'number', required: true, isNewFieldDefinition: false },
            { key: 'pickupWindow', label: 'Ventana de recogida', dataType: 'datetime', required: true, isNewFieldDefinition: true },
            { key: 'needsAssistance', label: 'Requiere asistencia especial', dataType: 'boolean', required: false, isNewFieldDefinition: true },
          ],
        },
      ],
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'Listo, este servicio queda armado con la versión publicada de la receta.',
      proposals: [
        {
          kind: 'service',
          id: 'service-launch-valid',
          status: 'valid',
          projectName: 'Cumbre Regional 2026',
          recipeName: 'Transporte aeropuerto — grupo VIP',
          recipeVersionLabel: 'Versión 3',
          values: [
            { key: 'flightNumber', label: 'Número de vuelo', value: 'AV204' },
            { key: 'passengerCount', label: 'Número de pasajeros', value: '6' },
            { key: 'pickupWindow', label: 'Ventana de recogida', value: '2026-09-04 06:30' },
          ],
        },
      ],
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'Casi todo listo para este servicio, pero hay un par de cosas por resolver antes de crearlo.',
      proposals: [
        {
          kind: 'service',
          id: 'service-launch-gaps',
          status: 'needsResolution',
          projectName: 'Cumbre Regional 2026',
          recipeName: 'Traslado terrestre — delegaciones',
          recipeVersionLabel: 'Versión 1',
          values: [
            { key: 'passengerCount', label: 'Número de pasajeros', value: '12' },
            { key: 'pickupLocation', label: 'Punto de recogida', value: 'Terminal Norte' },
          ],
          gaps: [
            'La ubicación "Terminal Norte" no existe en esta organización.',
            'El campo "Vehículo asignado" está archivado y no puede recibir un valor nuevo.',
          ],
        },
      ],
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'Arme una propuesta de receta, pero la validación encontró problemas antes de poder crearla.',
      proposals: [
        {
          kind: 'recipe',
          id: 'recipe-shuttle-invalid',
          status: 'invalid',
          recipeName: 'Traslado nocturno',
          recipeKey: 'traslado nocturno',
          fields: [
            { key: 'passengerCount', label: 'Número de pasajeros', dataType: 'number', required: true, isNewFieldDefinition: false },
            { key: 'passengerCount', label: 'Cantidad de pasajeros', dataType: 'text', required: true, isNewFieldDefinition: true },
          ],
          issues: [
            'La clave de receta "traslado nocturno" no es lowerCamelCase.',
            'La clave de campo "passengerCount" está repetida en la misma receta.',
          ],
        },
      ],
    },
  ],
  'en-US': [
    {
      role: 'assistant',
      status: 'complete',
      text:
        'I can help you put together a new recipe, create a service from a published recipe, ' +
        'or review what already exists. Tell me what you need and I will propose something concrete.',
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'Based on what you described, I put together this recipe. Review the proposed fields.',
      proposals: [
        {
          kind: 'recipe',
          id: 'recipe-shuttle-valid',
          status: 'valid',
          recipeName: 'Airport transfer — VIP group',
          recipeKey: 'airportTransferVip',
          fields: [
            { key: 'flightNumber', label: 'Flight number', dataType: 'text', required: true, isNewFieldDefinition: false },
            { key: 'passengerCount', label: 'Passenger count', dataType: 'number', required: true, isNewFieldDefinition: false },
            { key: 'pickupWindow', label: 'Pickup window', dataType: 'datetime', required: true, isNewFieldDefinition: true },
            { key: 'needsAssistance', label: 'Needs special assistance', dataType: 'boolean', required: false, isNewFieldDefinition: true },
          ],
        },
      ],
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'Done — this service is put together using the published recipe version.',
      proposals: [
        {
          kind: 'service',
          id: 'service-launch-valid',
          status: 'valid',
          projectName: 'Regional Summit 2026',
          recipeName: 'Airport transfer — VIP group',
          recipeVersionLabel: 'Version 3',
          values: [
            { key: 'flightNumber', label: 'Flight number', value: 'AV204' },
            { key: 'passengerCount', label: 'Passenger count', value: '6' },
            { key: 'pickupWindow', label: 'Pickup window', value: '2026-09-04 06:30' },
          ],
        },
      ],
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'Almost ready for this service, but there are a couple of things to resolve before creating it.',
      proposals: [
        {
          kind: 'service',
          id: 'service-launch-gaps',
          status: 'needsResolution',
          projectName: 'Regional Summit 2026',
          recipeName: 'Ground transfer — delegations',
          recipeVersionLabel: 'Version 1',
          values: [
            { key: 'passengerCount', label: 'Passenger count', value: '12' },
            { key: 'pickupLocation', label: 'Pickup point', value: 'North Terminal' },
          ],
          gaps: [
            'The location "North Terminal" does not exist in this organization.',
            'The field "Assigned vehicle" is archived and cannot receive a new value.',
          ],
        },
      ],
    },
    {
      role: 'assistant',
      status: 'complete',
      text: 'I put together a recipe proposal, but validation found problems before it could be created.',
      proposals: [
        {
          kind: 'recipe',
          id: 'recipe-shuttle-invalid',
          status: 'invalid',
          recipeName: 'Overnight transfer',
          recipeKey: 'overnight transfer',
          fields: [
            { key: 'passengerCount', label: 'Passenger count', dataType: 'number', required: true, isNewFieldDefinition: false },
            { key: 'passengerCount', label: 'Number of passengers', dataType: 'text', required: true, isNewFieldDefinition: true },
          ],
          issues: [
            'The recipe key "overnight transfer" is not lowerCamelCase.',
            'The field key "passengerCount" is duplicated within the same recipe.',
          ],
        },
      ],
    },
  ],
};

export interface StubChatBackendOptions {
  /** Injectable clock, so tests get deterministic timestamps. */
  readonly now?: () => number;
  /** Injectable id generator, so tests get deterministic turn ids. */
  readonly createId?: () => string;
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

/**
 * The stub implementation of `ChatBackend`. Returns canned turns from an
 * in-memory bank, cycling deterministically per backend instance — no network
 * calls, no API keys, nothing model-shaped ships in the browser bundle. The
 * special input "error" (any case, any locale) always rejects, which is how
 * the message list's error turn is exercised without a flaky or
 * nondeterministic stub.
 */
export function createStubChatBackend(options: StubChatBackendOptions = {}): ChatBackend {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? defaultCreateId;
  let cursor = 0;

  return {
    async sendMessage({ text, locale }: ChatSendMessageRequest): Promise<ChatTurn> {
      if (isErrorTrigger(text)) {
        throw new ChatBackendError('The stub chat backend rejected this message on purpose.');
      }

      const bank = cannedTurns[locale];
      const canned = bank[cursor % bank.length];
      if (canned === undefined) throw new ChatBackendError(`No canned turns configured for locale "${locale}".`);
      cursor += 1;

      return { ...canned, id: createId(), createdAt: now() };
    },
  };
}
