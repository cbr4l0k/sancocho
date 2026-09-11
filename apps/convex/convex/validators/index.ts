import { v, type Validator } from 'convex/values';

/**
 * The Convex pagination envelope, stated once for every paginated public query.
 *
 * The shape must match `PaginationResult` exactly — a `returns` validator that
 * omits `splitCursor`/`pageStatus` rejects legitimate pages at runtime. It was
 * previously copied into five query modules, so a fix to one could silently
 * leave the other four wrong; this is the single definition they all build on.
 */
export function paginatedResult<DocValidator extends Validator<unknown, 'required', string>>(docValidator: DocValidator) {
  return v.object({
    page: v.array(docValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  });
}

export const roleValidator = v.union(
  v.literal('owner'),
  v.literal('admin'),
  v.literal('planner'),
  v.literal('operator'),
  v.literal('viewer'),
);

/** Code-owned currency vocabulary for every persisted money value. */
export const currencyValidator = v.union(
  v.literal('COP'),
  v.literal('USD'),
  v.literal('EUR'),
  v.literal('MXN'),
);

/** Code-owned Rate Card grid axis; tenant-authored modality text is forbidden (I8). */
export const rateModalityValidator = v.union(
  v.literal('transfer'),
  v.literal('disposition'),
  v.literal('route'),
  v.literal('fixed'),
);

export const rateCardVersionStatusValidator = v.union(
  v.literal('draft'),
  v.literal('published'),
  v.literal('retired'),
);

export const serviceKindStatusValidator = v.union(
  v.literal('draft'),
  v.literal('active'),
  v.literal('archived'),
);

/**
 * `pending` is the only status a caller ever creates; the rest are
 * server-assigned outcomes (I4). There is no scheduled sweep (I8: no
 * workflow/cron machinery added speculatively), so `expired` is settled
 * lazily and asymmetrically:
 *
 * - `acceptInvitation` CANNOT persist the transition — a Convex mutation is
 *   one atomic transaction, and it always throws when an invitation is past
 *   `expiresAt`, which rolls back any write made in the same call. It
 *   compares `expiresAt` to now directly instead and leaves `status`
 *   untouched.
 * - `createInvitation` CAN — it is a success path with no throw afterward,
 *   so when a duplicate-address check finds a `pending` row past its own
 *   `expiresAt`, it settles that row to `expired` before proceeding, which
 *   is also what frees the address up for a fresh invitation.
 *
 * Every OTHER reader of this table (the pending-invitation lists) must still
 * treat a `pending` row past its own `expiresAt` as effectively expired
 * rather than trusting `status` alone, since nothing guarantees a
 * `createInvitation` call has ever run against that address since it lapsed.
 */
export const invitationStatusValidator = v.union(
  v.literal('pending'),
  v.literal('accepted'),
  v.literal('revoked'),
  v.literal('expired'),
);

export const serviceKindVersionStatusValidator = v.union(
  v.literal('draft'),
  v.literal('published'),
  v.literal('retired'),
);

export const serviceStatusValidator = v.union(
  v.literal('draft'),
  v.literal('planned'),
  v.literal('confirmed'),
  v.literal('active'),
  v.literal('completed'),
  v.literal('cancelled'),
);

/** Archival is preferred over destructive deletion for projects and fields. */
export const archivalStatusValidator = v.union(v.literal('active'), v.literal('archived'));
export const projectStatusValidator = v.union(
  v.literal('draft'),
  v.literal('active'),
  v.literal('completed'),
  v.literal('archived'),
);
export const eventStatusValidator = v.union(
  v.literal('draft'),
  v.literal('active'),
  v.literal('completed'),
  v.literal('archived'),
);
export const fieldDefinitionStatusValidator = archivalStatusValidator;

/** Code-owned location taxonomy; locations are reference data, never free-form types. */
export const locationTypeValidator = v.union(
  v.literal('airport'),
  v.literal('hotel'),
  v.literal('venue'),
  v.literal('office'),
  v.literal('station'),
  v.literal('depot'),
  v.literal('custom'),
);

/**
 * Single definition of the projects table shape: `schema.ts` builds the table
 * from it and the public queries build their `returns` validator from it, so
 * the stored document and the documented API contract cannot drift.
 */
export const projectFields = {
  organizationId: v.id('organizations'),
  name: v.string(),
  description: v.optional(v.string()),
  status: projectStatusValidator,
  startsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
};

export const projectDocValidator = v.object({
  _id: v.id('projects'),
  _creationTime: v.number(),
  ...projectFields,
});

/**
 * Shared persisted and returned shape for the Project-owned Event layer.
 *
 * The four optional reference/budget columns carry the shared context an Event
 * holds once on behalf of every Service under it. Each is validated in
 * `events/model.ts` against the Event's own organization before it is stored:
 * a venue Location (same organization, `type: 'venue'`), a client Cost Centre
 * (same organization), an accountable User (a current member of that
 * organization), and a budget expressed as integer minor units plus its
 * currency. `budgetAmount` and `budgetCurrency` are stored both-or-neither —
 * the schema cannot express that pairing, so the model owns it.
 */
export const eventFields = {
  organizationId: v.id('organizations'),
  projectId: v.id('projects'),
  name: v.string(),
  status: eventStatusValidator,
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  venueLocationId: v.optional(v.id('locations')),
  clientCostCentreId: v.optional(v.id('costCentres')),
  // Integer minor units (#83's `assertMinorUnits`), never a decimal major-unit
  // figure. A budget is a planning number, not agreed money, so I10 does not
  // freeze it: it is editable through `updateEvent` like any other column.
  budgetAmount: v.optional(v.number()),
  budgetCurrency: v.optional(currencyValidator),
  accountableUserId: v.optional(v.id('users')),
};

export const eventDocValidator = v.object({
  _id: v.id('events'),
  _creationTime: v.number(),
  ...eventFields,
});

/**
 * Single definition of the serviceKinds table shape, mirroring `projectFields`/
 * `serviceFields` above: `schema.ts` builds the table from it and every public
 * query builds its `returns` validator from it, so the stored document and the
 * documented API contract cannot drift. Before this it was declared a second
 * time (schema.ts had its own inline shape, and `serviceKinds/queries.ts`
 * hand-rolled its own copy of the return shape) — a column added to one would
 * have been silently rejected by the others at runtime.
 */
export const serviceKindFields = {
  organizationId: v.id('organizations'),
  key: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  status: serviceKindStatusValidator,
};

export const serviceKindDocValidator = v.object({
  _id: v.id('serviceKinds'),
  _creationTime: v.number(),
  ...serviceKindFields,
});

/** Shared persisted and returned shape for organization-owned locations. */
export const locationFields = {
  organizationId: v.id('organizations'),
  name: v.string(),
  // Server-derived from `name` through normalizeSearchText; never client-supplied
  // (I4). Optional only for pre-column rows awaiting the administrative backfill.
  searchText: v.optional(v.string()),
  type: locationTypeValidator,
  address: v.optional(v.string()),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  status: archivalStatusValidator,
};

export const locationDocValidator = v.object({
  _id: v.id('locations'),
  _creationTime: v.number(),
  ...locationFields,
});

/** Shared persisted and returned shape for organization-owned Cost Centres. */
export const costCentreFields = {
  organizationId: v.id('organizations'),
  key: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  externalReference: v.optional(v.string()),
  // Derived from `name` through normalizeSearchText in every write path (I4).
  // Optional only for migration/backfill symmetry with the locations catalogue.
  searchText: v.optional(v.string()),
  status: archivalStatusValidator,
};

export const costCentreDocValidator = v.object({
  _id: v.id('costCentres'),
  _creationTime: v.number(),
  ...costCentreFields,
});

/**
 * A Provider's claimed state is a REAL, published value, never something a
 * client infers from a null. It is derived from `linkedOrganizationId` on every
 * read (`toProviderView`) rather than stored, so the discriminator and the link
 * can never disagree: there is exactly one source of truth and no second column
 * to keep in step. Only #86's dedicated claim/revocation mutations move a
 * Provider between the two states; the generic update path cannot name the link
 * at all (see `providers/model.ts`).
 */
export const providerClaimStateValidator = v.union(v.literal('unclaimed'), v.literal('claimed'));

/**
 * Shared persisted and returned shape for the coordinator-owned Providers
 * directory (docs/provider-access.md shape (b)). A Provider is a reference row
 * for an external firm — a name and a way to reach them — not a CRM record.
 *
 * `linkedOrganizationId` is present from day one and unused until #86: adding a
 * nullable column now is free, adding it once Assignments reference Providers
 * is a migration. It is written ONLY by #86's claim/revocation mutations.
 *
 * `searchText` is required rather than optional (the locations and costCentres
 * catalogues carry it optional only for pre-column rows; this table has none).
 * It is derived from `name` through `normalizeSearchText` in every write path
 * (I4) and is load-bearing twice over: it backs name search AND it is the
 * case-normalised uniqueness key behind `by_org_searchText`.
 */
export const providerFields = {
  organizationId: v.id('organizations'),
  name: v.string(),
  legalName: v.optional(v.string()),
  taxId: v.optional(v.string()),
  contactName: v.optional(v.string()),
  contactEmail: v.optional(v.string()),
  contactPhone: v.optional(v.string()),
  notes: v.optional(v.string()),
  searchText: v.string(),
  status: archivalStatusValidator,
  linkedOrganizationId: v.optional(v.id('organizations')),
};

/**
 * The published Provider document. Unlike every other catalogue this is NOT the
 * bare stored row: `claimState` is derived server-side and returned alongside
 * the columns, so no client ever has to read lifecycle meaning out of an absent
 * `linkedOrganizationId`.
 */
export const providerDocValidator = v.object({
  _id: v.id('providers'),
  _creationTime: v.number(),
  ...providerFields,
  claimState: providerClaimStateValidator,
});

/** Shared persisted and returned shape for coordinator-owned Rate Cards. */
export const rateCardFields = {
  organizationId: v.id('organizations'),
  providerId: v.id('providers'),
  name: v.string(),
  status: archivalStatusValidator,
  // Server-maintained in the same transaction as publication/retirement. It is
  // never accepted by a public mutation (I4).
  currentPublishedVersionId: v.optional(v.id('rateCardVersions')),
};

export const rateCardDocValidator = v.object({
  _id: v.id('rateCards'),
  _creationTime: v.number(),
  ...rateCardFields,
});

export const rateCardVersionFields = {
  organizationId: v.id('organizations'),
  rateCardId: v.id('rateCards'),
  versionNumber: v.number(),
  currency: currencyValidator,
  status: rateCardVersionStatusValidator,
  publishedAt: v.optional(v.number()),
};

export const rateCardVersionDocValidator = v.object({
  _id: v.id('rateCardVersions'),
  _creationTime: v.number(),
  ...rateCardVersionFields,
});

export const rateLineFields = {
  organizationId: v.id('organizations'),
  rateCardVersionId: v.id('rateCardVersions'),
  vehicleClassId: v.id('vehicleClasses'),
  modality: rateModalityValidator,
  // Integer minor units; every writer additionally calls assertMinorUnits.
  unitAmount: v.number(),
};

export const rateLineDocValidator = v.object({
  _id: v.id('rateLines'),
  _creationTime: v.number(),
  ...rateLineFields,
});

/** Negotiation state for one immutable set of Assignment terms. */
export const assignmentRevisionStatusValidator = v.union(
  v.literal('draft'),
  v.literal('accepted'),
  v.literal('superseded'),
  v.literal('declined'),
);

/** Operational lifecycle of the stable Assignment row. */
export const executionStatusValidator = v.union(
  v.literal('unassigned'),
  v.literal('assigned'),
  v.literal('confirmed'),
  v.literal('dispatched'),
  v.literal('completed'),
  v.literal('notExecuted'),
);

/** Stable supply identity. Commercial terms live only on its revisions. */
export const assignmentFields = {
  organizationId: v.id('organizations'),
  serviceId: v.id('services'),
  projectId: v.id('projects'),
  providerId: v.id('providers'),
  costCentreId: v.optional(v.id('costCentres')),
  position: v.number(),
  notes: v.optional(v.string()),
  executionStatus: executionStatusValidator,
  fleetVehicleId: v.optional(v.id('fleetVehicles')),
  vehiclePlateOverride: v.optional(v.string()),
  driverName: v.optional(v.string()),
  driverPhone: v.optional(v.string()),
  dispatchedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  notExecutedReason: v.optional(v.string()),
  notExecutedAmount: v.optional(v.number()),
  additionalCharges: v.optional(v.number()),
  additionalDetail: v.optional(v.string()),
  // Maintained only by acceptance/decline transactions; never client supplied.
  currentRevisionId: v.optional(v.id('assignmentRevisions')),
};

export const assignmentDocValidator = v.object({
  _id: v.id('assignments'),
  _creationTime: v.number(),
  ...assignmentFields,
});

/**
 * The Provider arm's Assignment shape, matching `providerAssignmentView` in
 * `assignments/model.ts`. DERIVED by subtraction for the same reason as the
 * revision validator below: one definition, so the two cannot drift.
 *
 * WHAT THIS DOES NOT DO, stated plainly because an earlier version of this
 * comment claimed otherwise and mutation testing disproved it: it does not stop
 * an un-narrowed row from reaching a Provider. Every column it subtracts is
 * `v.optional`, and the queries publish `anyArmAssignmentDocValidator` — a union
 * whose full-document arm therefore accepts a completely un-narrowed row. It
 * documents the contract and it keeps the two shapes in one place; it enforces
 * nothing.
 *
 * The `Omit<>` return type is not the enforcement either: TypeScript does not
 * apply excess-property checking to spread-produced properties, so a refactor
 * writing `{ ...assignment }` inside that whitelist compiles clean and validates
 * clean, shipping `costCentreId` — frequently the Event's `clientCostCentreId`
 * copied verbatim (may-not-see #7 and #9) — to a Provider.
 *
 * The ONLY enforcement is the absent-key assertions in the tests:
 * `expectNoForbiddenProviderKeys` in `tests/assignments.test.ts` and its twin in
 * `tests/providerPortal.test.ts`. Every Provider-facing Assignment read must be
 * covered by one of them. The revision validator below IS load-bearing, because
 * two of the three columns it subtracts are required.
 */
const {
  costCentreId: _providerHiddenCostCentreId,
  notExecutedAmount: _providerHiddenNotExecutedAmount,
  additionalCharges: _providerHiddenAdditionalCharges,
  additionalDetail: _providerHiddenAdditionalDetail,
  ...providerAssignmentFields
} = assignmentFields;

export const providerAssignmentDocValidator = v.object({
  _id: v.id('assignments'),
  _creationTime: v.number(),
  ...providerAssignmentFields,
});

/** Either arm's Assignment shape, for the reads both arms may perform. */
export const anyArmAssignmentDocValidator = v.union(
  assignmentDocValidator,
  providerAssignmentDocValidator,
);

/**
 * A priced snapshot. The commercial columns are never patched after insert;
 * only lifecycle columns move as the negotiation is accepted or declined.
 */
export const assignmentRevisionFields = {
  organizationId: v.id('organizations'),
  assignmentId: v.id('assignments'),
  revisionNumber: v.number(),
  status: assignmentRevisionStatusValidator,
  vehicleClassId: v.id('vehicleClasses'),
  modality: rateModalityValidator,
  quantity: v.number(),
  rateCardVersionId: v.id('rateCardVersions'),
  rateLineId: v.id('rateLines'),
  unitAmount: v.number(),
  currency: currencyValidator,
  lineTotal: v.number(),
  acceptedAt: v.optional(v.number()),
  acceptedByUserId: v.optional(v.id('users')),
  declinedReason: v.optional(v.string()),
};

export const assignmentRevisionDocValidator = v.object({
  _id: v.id('assignmentRevisions'),
  _creationTime: v.number(),
  ...assignmentRevisionFields,
});

/**
 * The Provider arm's revision shape: the firm's own commercial record, minus
 * the three columns that point back into the coordinator's side of it.
 * `rateCardVersionId` and `rateLineId` name the card and the exact cell a rate
 * was resolved from, which `docs/provider-access.md` may-not-see #8 forbids;
 * `acceptedByUserId` names a coordinator member (may-not-see #11). None can be
 * dereferenced by a Provider, but an id discloses on its own — two Assignments
 * sharing a `rateLineId` prove they were priced off the same line.
 *
 * DERIVED from `assignmentRevisionFields` by subtraction rather than restated,
 * so the stored row and this contract cannot drift. The safety of inheriting
 * future columns by default rests on `ProviderRevisionView` in
 * `assignments/model.ts`: its body is a whitelist typed as an `Omit` of the
 * stored row, so a new REQUIRED column fails to compile there until someone
 * decides, and a new OPTIONAL one is simply never populated.
 */
const {
  rateCardVersionId: _providerHiddenRateCardVersionId,
  rateLineId: _providerHiddenRateLineId,
  acceptedByUserId: _providerHiddenAcceptedByUserId,
  ...providerAssignmentRevisionFields
} = assignmentRevisionFields;

export const providerAssignmentRevisionDocValidator = v.object({
  _id: v.id('assignmentRevisions'),
  _creationTime: v.number(),
  ...providerAssignmentRevisionFields,
});

/**
 * A grant is either live or it is not. There is deliberately no `expired`,
 * `pending` or `suspended` member: every additional state is another way for a
 * resolution path to treat "not active" as "close enough to active", and the
 * one question the gate asks on every single call is exactly this binary.
 */
export const providerAccessGrantStatusValidator = v.union(v.literal('active'), v.literal('revoked'));

/**
 * The second principal arm's stored proof (docs/provider-access.md shape (b),
 * issue #71). A row here says: the coordinator `organizationId` has granted the
 * Provider `providerId` — whose claimed Organization is `providerOrganizationId`
 * — access to `projectId`, and nothing else.
 *
 * What is NOT on this row is as load-bearing as what is:
 *
 * - **No capability column.** The capability set a grant confers is code-owned,
 *   enumerated and closed (`providerGrantCapabilities` in `lib/access.ts`).
 *   Storing it would make disclosure tenant-configurable, which I8 and the
 *   decision record both forbid: widening what a provider sees must be a
 *   reviewed code change, never a row a coordinator can edit.
 * - **No role column.** The membership ladder is the other axis and does not
 *   compose with this one.
 * - **No parent grant / delegation column.** Grants are non-transitive by
 *   construction: there is nowhere to record that one grant issued another.
 *
 * `providerOrganizationId` is derived server-side from the Provider row's
 * `linkedOrganizationId` at grant time (I4) and is re-proven against the live
 * link on every resolution, so revoking a claim revokes every grant that rode
 * on it without touching a single grant row.
 */
export const providerAccessGrantFields = {
  organizationId: v.id('organizations'),
  providerId: v.id('providers'),
  providerOrganizationId: v.id('organizations'),
  projectId: v.id('projects'),
  status: providerAccessGrantStatusValidator,
  grantedByUserId: v.id('users'),
  grantedAt: v.number(),
  revokedAt: v.optional(v.number()),
};

export const providerAccessGrantDocValidator = v.object({
  _id: v.id('providerAccessGrants'),
  _creationTime: v.number(),
  ...providerAccessGrantFields,
});

/** Provider-owned discovery row; deliberately carries no Project columns. */
export const providerEngagementFields = {
  projectId: v.id('projects'),
  providerId: v.id('providers'),
  organizationId: v.id('organizations'),
};

export const providerEngagementDocValidator = v.object({
  _id: v.id('providerAccessGrants'),
  ...providerEngagementFields,
});

/**
 * The unit of SUPPLY THAT IS PLANNED AND PRICED (#65): "a Sprinter, 18 pax".
 *
 * Tenant-authored vocabulary, deliberately NOT a code-owned enum — the exact
 * Field-Definition argument. One operator prices `Sprinter 18 pax`, `Gama
 * media` and `Duster`; another city's operator prices something else entirely.
 * A code-owned union would force every such tenant through a translation layer
 * that no rate card could then reference.
 *
 * `key` is the stable, org-unique identifier (same lowerCamelCase rule as Cost
 * Centre and Field Definition keys) so the starter catalogue can be provisioned
 * idempotently and a later import can address a class by name-independent id.
 *
 * `passengerCapacity` and `cargoCapacityNote` are the two facts that make a
 * class *plannable*, and nothing more: this is not a vehicle-specification
 * system. Cargo is a free-form note rather than a number because "1.5 t / 12 m³
 * / two pallets" is how operators actually state it, and inventing a unit here
 * would either lose that or force a conversion engine (I8).
 *
 * `searchText` is server-derived from key and name (I4) and required rather
 * than optional: this table has no pre-column rows to be tolerant of.
 */
export const vehicleClassFields = {
  organizationId: v.id('organizations'),
  key: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  passengerCapacity: v.optional(v.number()),
  cargoCapacityNote: v.optional(v.string()),
  searchText: v.string(),
  status: archivalStatusValidator,
};

export const vehicleClassDocValidator = v.object({
  _id: v.id('vehicleClasses'),
  _creationTime: v.number(),
  ...vehicleClassFields,
});

/**
 * The unit of supply THAT ACTUALLY SHOWS UP (#65): "plate ABC123".
 *
 * Ownership is settled and is not re-litigated here: this row lives in the
 * COORDINATOR's organization and points at the coordinator's own Provider
 * directory row. The provider firm's Organization receives scoped grant
 * capabilities (#71), never a catalogue of its own — a provider-tenant-owned
 * fleet would require a cross-tenant sharing and class-mapping system that is
 * explicitly out of scope.
 *
 * `plate` is stored EXACTLY as the coordinator typed it, because that is what a
 * dispatcher reads off a windscreen. `plateKey` is the server-derived
 * normalised form (I4) and is the uniqueness key: `ABC 123`, `abc-123` and
 * `  abc123  ` are one vehicle, and storing the key beside the display value is
 * what lets both facts be true at once. `searchText` covers both forms so a
 * search for either spelling finds the row.
 *
 * `year` and `notes` are the whole of the "specification"; there is deliberately
 * no odometer, fuel, insurance, document-expiry or availability column. A Fleet
 * Vehicle is a plate that belongs to a Provider and is of a Class, and nothing
 * more (CLAUDE.md non-goals).
 */
export const fleetVehicleFields = {
  organizationId: v.id('organizations'),
  providerId: v.id('providers'),
  vehicleClassId: v.id('vehicleClasses'),
  plate: v.string(),
  // Server-derived from `plate` through `normalizePlate` in every write path
  // (I4); never client-supplied, and the only column `by_org_plateKey` reads.
  plateKey: v.string(),
  label: v.optional(v.string()),
  year: v.optional(v.number()),
  notes: v.optional(v.string()),
  searchText: v.string(),
  status: archivalStatusValidator,
};

export const fleetVehicleDocValidator = v.object({
  _id: v.id('fleetVehicles'),
  _creationTime: v.number(),
  ...fleetVehicleFields,
});

/**
 * The invitation kind is a structural security boundary, not an optional
 * column plus a convention. A Provider claim can never carry `role`, so the
 * ordinary membership acceptance path cannot turn the claim recipient into a
 * coordinator member even if a future caller forgets a runtime check. Keeping
 * the two shapes as a discriminated union makes that escalation unrepresentable
 * in the table and forces every consumer to narrow before reading arm-specific
 * fields.
 *
 * `email` remains the addressing key — never a user id — so inviting an address
 * with an account is indistinguishable from inviting one without one (I9).
 * Nothing about either arm is resolved by looking a user up by email.
 */
const membershipInvitationFields = {
  kind: v.literal('membership'),
  organizationId: v.id('organizations'),
  // Normalized (trimmed, lowercased) at write time so the uniqueness index
  // and the recipient's equality check both compare like-for-like.
  email: v.string(),
  role: roleValidator,
  status: invitationStatusValidator,
  invitedByUserId: v.id('users'),
  expiresAt: v.number(),
};

const providerClaimInvitationFields = {
  kind: v.literal('providerClaim'),
  organizationId: v.id('organizations'),
  email: v.string(),
  providerId: v.id('providers'),
  status: invitationStatusValidator,
  invitedByUserId: v.id('users'),
  expiresAt: v.number(),
};

const invitationSystemFields = {
  _id: v.id('organizationInvitations'),
  _creationTime: v.number(),
};

export const organizationInvitationValidator = v.union(
  v.object(membershipInvitationFields),
  v.object(providerClaimInvitationFields),
);

// Spread from the same two arm definitions above rather than restated, so the
// stored document and the published API contract cannot drift — the property
// this module has held since #56 and the reason the shape lives here at all.
// Two hand-copied unions would let a column reach the table while the `returns`
// validator silently rejected it at runtime.
export const organizationInvitationDocValidator = v.union(
  v.object({ ...invitationSystemFields, ...membershipInvitationFields }),
  v.object({ ...invitationSystemFields, ...providerClaimInvitationFields }),
);

/**
 * Single definition of the services table shape: `schema.ts` builds the table from
 * it and the public queries build their `returns` validator from it, so the
 * stored document and the documented API contract cannot drift. It was declared
 * twice — once per side — and a column added to one would have silently been
 * rejected by the other at runtime.
 *
 * `serviceKindId` is derived from `serviceKindVersionId` server-side and `organizationId`
 * from the stored entity graph (I4); neither is ever accepted from client args,
 * which is why no public mutation validator repeats them.
 */
export const serviceFields = {
  organizationId: v.id('organizations'),
  projectId: v.id('projects'),
  eventId: v.id('events'),
  serviceKindId: v.id('serviceKinds'),
  serviceKindVersionId: v.id('serviceKindVersions'),
  name: v.string(),
  status: serviceStatusValidator,
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
};

export const serviceDocValidator = v.object({
  _id: v.id('services'),
  _creationTime: v.number(),
  ...serviceFields,
});

/** Built-in vs org-owned field definitions; must agree with organizationId presence. */
export const fieldScopeValidator = v.union(v.literal('builtin'), v.literal('organization'));

/** Code-owned relationship taxonomy (issue #12); never a free string (I8). */
export const relationshipTypeValidator = v.union(
  v.literal('dependsOn'),
  v.literal('follows'),
  v.literal('parentOf'),
  v.literal('relatedTo'),
);

export const fieldDataTypeValidator = v.union(
  v.literal('text'),
  v.literal('longText'),
  v.literal('number'),
  v.literal('boolean'),
  v.literal('date'),
  v.literal('datetime'),
  v.literal('time'),
  v.literal('select'),
  v.literal('multiSelect'),
  v.literal('location'),
);

/** Convex stores date/time values as strings; runtime code also checks calendar/clock validity. */
export const dateStringValidator = v.string();
export const timeStringValidator = v.string();

export const dateStringPattern = /^\d{4}-\d{2}-\d{2}$/;
export const timeStringPattern = /^\d{2}:\d{2}$/;

export function isValidDateString(value: string): boolean {
  if (!dateStringPattern.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isValidTimeString(value: string): boolean {
  if (!timeStringPattern.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export const selectOptionValidator = v.object({
  id: v.string(),
  label: v.string(),
});

/**
 * One config union binds data type, validation rules, and options together so a
 * document can never carry rules or options that disagree with its data type
 * (impossible states unrepresentable). Used by fieldDefinitions (source of
 * truth for drafts) and serviceKindFields (immutable snapshot taken at publish —
 * this snapshot is what historical service validation reads, making I3
 * structural rather than procedural). For select/multiSelect the snapshotted
 * `options` list IS the allowed set.
 */
export const fieldConfigValidator = v.union(
  v.object({ kind: v.literal('text'), minLength: v.optional(v.number()), maxLength: v.optional(v.number()) }),
  v.object({ kind: v.literal('longText'), minLength: v.optional(v.number()), maxLength: v.optional(v.number()) }),
  v.object({ kind: v.literal('number'), min: v.optional(v.number()), max: v.optional(v.number()), integer: v.optional(v.boolean()) }),
  v.object({ kind: v.literal('boolean') }),
  v.object({ kind: v.literal('date'), min: v.optional(dateStringValidator), max: v.optional(dateStringValidator) }),
  v.object({ kind: v.literal('datetime'), min: v.optional(v.number()), max: v.optional(v.number()) }),
  v.object({ kind: v.literal('time'), min: v.optional(timeStringValidator), max: v.optional(timeStringValidator) }),
  v.object({ kind: v.literal('select'), options: v.array(selectOptionValidator) }),
  v.object({
    kind: v.literal('multiSelect'),
    options: v.array(selectOptionValidator),
    minSelections: v.optional(v.number()),
    maxSelections: v.optional(v.number()),
  }),
  v.object({ kind: v.literal('location') }),
);

/** Convex accepts NaN/Infinity in v.number(); numeric field values must pass this at runtime. */
export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Typed service values are shared by schema and future mutation arguments. Each
 * discriminator carries only the data valid for that field type (I8).
 * date/time/number/datetime branches are structurally loose at the Convex
 * layer (bare string/float64); every write path MUST go through the
 * centralized service validation gate (issue #10) which enforces calendar/clock
 * validity, finiteness, and serviceKind rules. Never use this union alone as the
 * only validation of a public mutation's field values.
 */
export const serviceFieldValueValidator = v.union(
  v.object({ kind: v.literal('text'), value: v.string() }),
  v.object({ kind: v.literal('longText'), value: v.string() }),
  v.object({ kind: v.literal('number'), value: v.number() }),
  v.object({ kind: v.literal('boolean'), value: v.boolean() }),
  v.object({ kind: v.literal('date'), value: dateStringValidator }),
  v.object({ kind: v.literal('datetime'), value: v.number() }),
  v.object({ kind: v.literal('time'), value: timeStringValidator }),
  v.object({ kind: v.literal('select'), optionId: v.string() }),
  v.object({ kind: v.literal('multiSelect'), optionIds: v.array(v.string()) }),
  v.object({ kind: v.literal('location'), locationId: v.id('locations') }),
);

/** Code-owned audit vocabulary (extended by each domain issue); never free strings (I8). */
export const auditActionValidator = v.union(
  v.literal('organization.created'),
  v.literal('organization.updated'),
  v.literal('membership.created'),
  v.literal('membership.updated'),
  v.literal('membership.removed'),
  v.literal('project.created'),
  v.literal('project.updated'),
  v.literal('project.archived'),
  v.literal('event.created'),
  v.literal('event.updated'),
  v.literal('event.statusChanged'),
  v.literal('event.archived'),
  v.literal('event.deleted'),
  v.literal('fieldDefinition.created'),
  v.literal('fieldDefinition.updated'),
  v.literal('fieldDefinition.archived'),
  v.literal('fieldDefinition.deleted'),
  v.literal('serviceKind.created'),
  v.literal('serviceKind.updated'),
  v.literal('serviceKind.archived'),
  v.literal('serviceKindVersion.created'),
  v.literal('serviceKindVersion.published'),
  v.literal('serviceKindVersion.retired'),
  v.literal('serviceKindField.added'),
  v.literal('serviceKindField.updated'),
  v.literal('serviceKindField.removed'),
  v.literal('serviceKindVersion.fieldsReordered'),
  v.literal('service.created'),
  // Two distinct update vocabularies, so two distinct actions: `service.updated`
  // records COLUMN NAMES in `metadata.changedFields` (updateServiceCoreFields),
  // `service.fieldsUpdated` records FIELD DEFINITION IDS (updateServiceFields).
  // One action for both forced every log consumer to sniff the value.
  v.literal('service.updated'),
  v.literal('service.fieldsUpdated'),
  v.literal('service.statusChanged'),
  v.literal('service.cancelled'),
  v.literal('location.created'),
  v.literal('location.updated'),
  v.literal('location.archived'),
  v.literal('location.deleted'),
  v.literal('costCentre.created'),
  v.literal('costCentre.updated'),
  v.literal('costCentre.archived'),
  v.literal('costCentre.deleted'),
  v.literal('provider.created'),
  v.literal('provider.updated'),
  v.literal('provider.archived'),
  v.literal('provider.deleted'),
  v.literal('rateCard.created'),
  v.literal('rateCard.updated'),
  v.literal('rateCard.archived'),
  v.literal('rateCardVersion.created'),
  v.literal('rateCardVersion.published'),
  v.literal('rateCardVersion.retired'),
  v.literal('assignment.created'),
  v.literal('assignment.removed'),
  v.literal('assignment.dispatchStatusChanged'),
  v.literal('assignment.vehicleAssigned'),
  v.literal('assignment.driverAssigned'),
  v.literal('assignment.notExecuted'),
  v.literal('assignment.adjustmentsRecorded'),
  v.literal('assignmentRevision.created'),
  v.literal('assignmentRevision.accepted'),
  v.literal('assignmentRevision.declined'),
  v.literal('assignmentRevision.superseded'),
  // The coordinator-side lifecycle of the second principal arm. Both are member
  // operations: a Provider principal can never reach either (issue #71).
  v.literal('providerAccessGrant.granted'),
  v.literal('providerAccessGrant.revoked'),
  v.literal('providerClaim.invited'),
  v.literal('providerClaim.invitationRevoked'),
  v.literal('providerClaim.accepted'),
  v.literal('providerClaim.revoked'),
  v.literal('vehicleClass.created'),
  v.literal('vehicleClass.updated'),
  v.literal('vehicleClass.archived'),
  v.literal('vehicleClass.deleted'),
  v.literal('fleetVehicle.created'),
  v.literal('fleetVehicle.updated'),
  v.literal('fleetVehicle.archived'),
  v.literal('fleetVehicle.deleted'),
  v.literal('relationship.created'),
  v.literal('relationship.removed'),
  v.literal('invitation.created'),
  v.literal('invitation.revoked'),
  v.literal('invitation.accepted'),
);

/**
 * Every entity type here is org-owned, which is exactly what `auditEvents`
 * requires: `organizationId` is non-optional, so an audit row can only exist for
 * something a tenant owns. There is deliberately no `user` member — the two
 * org-less operations in the codebase (`ensureUser`, which provisions the app
 * user before any membership exists, and `createBuiltinFieldDefinition`, which
 * seeds deployment-wide definitions) therefore write no audit row at all. That
 * gap is accepted rather than papered over: a nullable `organizationId` would
 * weaken the tenant-scoped index every audit read depends on (I1/I6), and both
 * operations are idempotent provisioning, not tenant activity. Should they ever
 * need auditing, it belongs in a separate deployment-scoped log, not here.
 */
export const auditEntityTypeValidator = v.union(
  v.literal('organization'),
  v.literal('membership'),
  v.literal('project'),
  v.literal('event'),
  v.literal('fieldDefinition'),
  v.literal('serviceKind'),
  v.literal('serviceKindVersion'),
  v.literal('serviceKindField'),
  v.literal('service'),
  v.literal('location'),
  v.literal('costCentre'),
  v.literal('provider'),
  v.literal('rateCard'),
  v.literal('rateCardVersion'),
  v.literal('assignment'),
  v.literal('assignmentRevision'),
  v.literal('providerAccessGrant'),
  v.literal('providerClaimInvitation'),
  v.literal('vehicleClass'),
  v.literal('fleetVehicle'),
  v.literal('serviceRelationship'),
  v.literal('invitation'),
);

/**
 * Metadata remains schema-compatible as a flat scalar record, but writes are
 * restricted to this code-owned key set in `recordAuditEvent`. That runtime
 * gate is what makes the audit policy's ban on secrets, tokens, provider
 * claims, and excessive PII enforceable rather than aspirational.
 */
export const auditMetadataKeys = [
  'changedFields',
  'clonedFromVersion',
  'costCentreId',
  'fieldCount',
  'fieldDefinitionId',
  'key',
  'linkedOrganizationId',
  'name',
  'phase',
  'plate',
  'position',
  'previousRole',
  'previousStatus',
  'projectId',
  'providerId',
  'assignmentId',
  'serviceKindVersionId',
  'role',
  'slug',
  'sourceServiceId',
  'status',
  'targetServiceId',
  'type',
  'versionNumber',
] as const;

export const auditMetadataKeySet: ReadonlySet<string> = new Set(auditMetadataKeys);
export type AuditMetadataKey = (typeof auditMetadataKeys)[number];
export const maxAuditMetadataStringLength = 512;

/**
 * Keys whose values are ASSEMBLED BY SERVER CODE (joined column names and
 * document ids) rather than copied from caller input. They are the only keys
 * allowed to exceed `maxAuditMetadataStringLength`, and they are truncated
 * instead of rejected — see `recordAuditEvent`.
 */
export const auditMetadataSummaryKeys = ['changedFields'] as const satisfies readonly AuditMetadataKey[];
export const auditMetadataSummaryKeySet: ReadonlySet<string> = new Set(auditMetadataSummaryKeys);

/**
 * Public audit reads accept a caller-supplied `entityId`; it is compared against
 * stored document ids (~33 characters), so anything longer cannot match and is
 * refused rather than turned into an index scan on unbounded input.
 */
export const maxAuditEntityIdLength = 128;

/**
 * Flat scalar metadata only. The key set above is GLOBAL and code-owned rather
 * than per-action, and deliberately so: every `recordAuditEvent` call site lives
 * in this repository's domain models (no caller ever names a metadata key), so a
 * per-action key map would only duplicate what the call sites already state,
 * while adding a second place to edit on every new action. The global set still
 * delivers the property that matters — a key not on this list can never reach
 * the database — and the compiler is the first gate: `recordAuditEvent`'s
 * `metadata` parameter is typed to these keys, so a misspelled or newly invented
 * key fails `typecheck`, with the runtime guard as defense in depth.
 *
 * This shape alone cannot prove the absence of secrets/tokens/PII; the key set
 * plus the string bound is what makes that policy enforceable.
 */
export const auditMetadataValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null()),
);

/**
 * Persisted audit row shape, shared by schema.ts and the public audit query
 * contract. `_creationTime` is the log time axis; Convex supplies it, so audit
 * rows deliberately have no duplicate `createdAt` column.
 */
export const auditEventFields = {
  organizationId: v.id('organizations'),
  actorUserId: v.id('users'),
  /**
   * The SECOND actor dimension I1 grew when the access chain gained a second
   * principal arm (#71): `actorUserId` says who acted, this says whose Provider
   * grant they were acting under. Absent on every member-arm write, which is
   * every write that exists today — a coordinator granting or revoking access is
   * acting as itself, not on a provider's behalf, so these rows deliberately do
   * NOT set it. #88 (provider writes) is its first producer.
   *
   * Optional rather than nullable so member rows carry no column at all, and so
   * "acting as a provider" is never something a reader has to infer from a null.
   */
  onBehalfOfProviderId: v.optional(v.id('providers')),
  action: auditActionValidator,
  entityType: auditEntityTypeValidator,
  entityId: v.string(),
  metadata: auditMetadataValidator,
};

export const auditEventDocValidator = v.object({
  _id: v.id('auditEvents'),
  _creationTime: v.number(),
  ...auditEventFields,
});

export type FieldDataType = typeof fieldDataTypeValidator.type;

/**
 * Code-owned capability vocabulary. Exported so callers receive a narrow union
 * instead of `string` and can never match capabilities by free-form comparison (I8).
 */
export type SemanticCapability =
  | 'serviceName'
  | 'serviceDescription'
  | 'serviceDate'
  | 'serviceTime'
  | 'serviceLocation'
  | 'passengerTotals'
  | 'occupancyMetrics'
  | 'capacityValidation'
  | 'flightTracking'
  | 'accessibilityRequirements';
type SemanticDefinition = Readonly<{
  expectedDataType: FieldDataType;
  capabilities: readonly SemanticCapability[];
  // Only meaningful when `expectedDataType` is `'number'`: a `count` of
  // discrete things (passengers, luggage pieces, wheelchairs) is never
  // fractional, so a field bound to one of these types must declare
  // `integer: true` on its `number` config. A fractional passenger count is
  // not a value this semantic type can mean, and any consumer summing or
  // averaging these values would inherit IEEE-754 residue from one. Omitted
  // (falls back to `false` implicitly, i.e. absent) for semantic types with
  // no such invariant.
  requiresInteger?: true | undefined;
  // How many field definitions one organization may bind to this semantic
  // type (today: `passenger.count`, `accessibility.wheelchairCount`).
  // `fields/model.ts` enforces it at field CREATE/UPDATE time
  // (`assertSemanticTypeCapacity`), reading this number rather than a
  // hand-copied literal, so the rule and the constant can never disagree.
  // Deliberately narrow: this is a per-(organization, semanticType) cap on
  // the types a per-write consumer resolves a field list for, not a general
  // field-count limit. Omitted for every type without such a consumer.
  maxFieldDefinitionsPerSemanticType?: number | undefined;
}>;

// A tenant can bind at most this many field definitions to
// `passenger.count` or `accessibility.wheelchairCount` — the counting
// semantic types a consumer has to resolve a whole field list for before it
// can interpret one service. Without a cap, an org that (deliberately or
// accidentally) bound an unusually large number of custom fields to the same
// type could push such a resolution past Convex's per-transaction read
// limit. 25 is real headroom over what a realistic tenant needs (a dozen or
// so: adult/child/infant/staff passenger counts, a couple of accessibility
// variants). Enforced by `assertSemanticTypeCapacity` in fields/model.ts.
export const maxTrackedFieldDefinitions = 25;

/** Code-owned semantics; tenant data may name a type but can never grant capabilities. */
export const semanticRegistry = Object.freeze({
  // `requiresInteger: undefined` / `maxFieldDefinitionsPerSemanticType:
  // undefined` are stated explicitly (not merely omitted) on every entry
  // that doesn't need them, so `semanticRegistry[type]` stays ONE consistent
  // object shape across every union member — a property only some entries
  // declared would make TypeScript reject reading it off the others at all
  // (not just report `undefined`), since `satisfies` (unlike `as`) preserves
  // each entry's own literal shape rather than unifying them.
  serviceName: { expectedDataType: 'text', capabilities: ['serviceName'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  serviceDescription: { expectedDataType: 'longText', capabilities: ['serviceDescription'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  serviceDate: { expectedDataType: 'date', capabilities: ['serviceDate'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  serviceTime: { expectedDataType: 'time', capabilities: ['serviceTime'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  serviceLocation: { expectedDataType: 'location', capabilities: ['serviceLocation'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'passenger.count': {
    expectedDataType: 'number',
    capabilities: ['passengerTotals', 'occupancyMetrics', 'capacityValidation'],
    requiresInteger: true,
    maxFieldDefinitionsPerSemanticType: maxTrackedFieldDefinitions,
  },
  'transport.origin': { expectedDataType: 'location', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'transport.destination': { expectedDataType: 'location', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'aviation.flightNumber': { expectedDataType: 'text', capabilities: ['flightTracking'], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'luggage.count': { expectedDataType: 'number', capabilities: [], requiresInteger: true, maxFieldDefinitionsPerSemanticType: undefined },
  'accessibility.wheelchairCount': {
    expectedDataType: 'number',
    capabilities: ['accessibilityRequirements'],
    requiresInteger: true,
    maxFieldDefinitionsPerSemanticType: maxTrackedFieldDefinitions,
  },
  'contact.primary': { expectedDataType: 'text', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'aviation.terminal': { expectedDataType: 'text', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
  'general.notes': { expectedDataType: 'longText', capabilities: [], requiresInteger: undefined, maxFieldDefinitionsPerSemanticType: undefined },
} satisfies Record<string, SemanticDefinition>);

export type SemanticType = keyof typeof semanticRegistry;

/** Must stay in sync with semanticRegistry keys; the satisfies check below enforces it. */
export const semanticTypeValidator = v.union(
  v.literal('serviceName'),
  v.literal('serviceDescription'),
  v.literal('serviceDate'),
  v.literal('serviceTime'),
  v.literal('serviceLocation'),
  v.literal('passenger.count'),
  v.literal('transport.origin'),
  v.literal('transport.destination'),
  v.literal('aviation.flightNumber'),
  v.literal('luggage.count'),
  v.literal('accessibility.wheelchairCount'),
  v.literal('contact.primary'),
  v.literal('aviation.terminal'),
  v.literal('general.notes'),
);

// Compile-time guard: the validator's type must be exactly the registry's key set.
type AssertSameKeys = typeof semanticTypeValidator.type extends SemanticType
  ? SemanticType extends typeof semanticTypeValidator.type
    ? true
    : never
  : never;
const _semanticKeysInSync: AssertSameKeys = true;
void _semanticKeysInSync;

/**
 * Single definition of the fieldDefinitions table shape: `schema.ts` builds the
 * table from it and the public queries build their `returns` validator from it,
 * so the stored document and the documented API contract cannot drift.
 *
 * Declared here (after `semanticTypeValidator`) rather than beside
 * `projectFields` only because it references validators defined further down.
 */
export const fieldDefinitionFields = {
  // scope must agree with organizationId presence: builtin ⇔ organizationId
  // absent. Enforced by the field-creation helpers in fields/model.ts.
  scope: fieldScopeValidator,
  organizationId: v.optional(v.id('organizations')),
  key: v.string(),
  label: v.string(),
  // Server-derived from `key` and `label` through normalizeSearchText; never
  // client-supplied (I4). Optional only for pre-column rows awaiting backfill.
  searchText: v.optional(v.string()),
  description: v.optional(v.string()),
  status: fieldDefinitionStatusValidator,
  semanticType: v.optional(semanticTypeValidator),
  // Data type + rules + options bound in one discriminated union.
  config: fieldConfigValidator,
};
