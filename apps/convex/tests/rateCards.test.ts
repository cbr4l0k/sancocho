import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { modules } from './helpers';

const ensureUser = api.auth.mutations.ensureUser;
const createOrganization = api.organizations.mutations.createOrganization;
const addMember = api.organizations.mutations.addMember;
const createProject = api.projects.mutations.createProject;
const createProvider = api.providers.mutations.createProvider;
const grantProjectAccessToProvider = api.providers.mutations.grantProjectAccessToProvider;
const createVehicleClass = api.vehicles.mutations.createVehicleClass;

const createRateCard = api.rateCards.mutations.createRateCard;
const updateRateCardMetadata = api.rateCards.mutations.updateRateCardMetadata;
const archiveRateCard = api.rateCards.mutations.archiveRateCard;
const createInitialDraftVersion = api.rateCards.mutations.createInitialDraftVersion;
const clonePublishedVersionToDraft = api.rateCards.mutations.clonePublishedVersionToDraft;
const updateRateCardVersion = api.rateCards.mutations.updateRateCardVersion;
const addRateLine = api.rateCards.mutations.addRateLine;
const updateRateLine = api.rateCards.mutations.updateRateLine;
const removeRateLine = api.rateCards.mutations.removeRateLine;
const publishRateCardVersion = api.rateCards.mutations.publishRateCardVersion;
const retireRateCardVersion = api.rateCards.mutations.retireRateCardVersion;
const getRateCard = api.rateCards.queries.getRateCard;
const getRateCardDetail = api.rateCards.queries.getRateCardDetail;
const listRateCards = api.rateCards.queries.listRateCards;
const listRateCardVersions = api.rateCards.queries.listRateCardVersions;
const getRateCardVersion = api.rateCards.queries.getRateCardVersion;
const resolveRate = api.rateCards.queries.resolveRate;

const issuer = 'https://example.clerk.accounts.dev';
const unauthenticated = 'unauthenticated';
const inaccessible = 'notFoundOrInaccessible';
const firstPage = { numItems: 10, cursor: null };

type SchemaTest = ReturnType<typeof convexTest<(typeof schema)['tables']>>;
type Client = ReturnType<SchemaTest['withIdentity']>;

function identity(subject: string) {
  return { issuer, subject, name: subject, email: `${subject}@example.com`, emailVerified: true };
}

async function provision(t: SchemaTest, subject: string) {
  const client = t.withIdentity(identity(subject));
  const userId: Id<'users'> = await client.mutation(ensureUser, {});
  return { client, userId };
}

async function fixture(subject = 'rate-cards') {
  const t = convexTest(schema, modules);
  const owner = await provision(t, `${subject}-owner`);
  const organizationId = await owner.client.mutation(createOrganization, {
    name: 'Andes Producciones',
    slug: `${subject}-coordinator`,
  });
  const providerId = await owner.client.mutation(createProvider, { organizationId, name: 'TransAndes SAS' });
  const vehicleClassId = await owner.client.mutation(createVehicleClass, {
    organizationId,
    key: 'sprinter18',
    name: 'Sprinter 18 pax',
  });
  const rateCardId = await owner.client.mutation(createRateCard, {
    organizationId,
    providerId,
    name: 'TransAndes 2026',
  });
  return { t, owner, organizationId, providerId, vehicleClassId, rateCardId };
}

async function addLine(
  client: Client,
  rateCardVersionId: Id<'rateCardVersions'>,
  vehicleClassId: Id<'vehicleClasses'>,
  unitAmount = 81_000_000,
) {
  return client.mutation(addRateLine, {
    rateCardVersionId,
    vehicleClassId,
    modality: 'disposition',
    unitAmount,
  });
}

async function publishedFixture(subject: string) {
  const f = await fixture(subject);
  const versionId = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: f.rateCardId, currency: 'COP' });
  const rateLineId = await addLine(f.owner.client, versionId, f.vehicleClassId);
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: versionId });
  return { ...f, versionId, rateLineId };
}

test('I7: version numbers are server-assigned, gapless, and cannot be submitted or predicted by a client', async () => {
  const { owner, rateCardId, vehicleClassId } = await fixture('rate-cards-i7');
  const untouched = await owner.client.mutation(createRateCard, {
    organizationId: (await owner.client.query(getRateCard, { rateCardId })).organizationId,
    providerId: (await owner.client.query(getRateCard, { rateCardId })).providerId,
    name: 'Server numbering probe',
  });
  const rejectedCreate: unknown = await owner.client
    // @ts-expect-error versionNumber is deliberately absent from the public API.
    .mutation(createInitialDraftVersion, { rateCardId: untouched, currency: 'COP', versionNumber: 99 })
    .catch((error: unknown) => error);
  expect(rejectedCreate).toBeInstanceOf(Error);
  expect(rejectedCreate).not.toHaveProperty('data');

  const v1 = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await addLine(owner.client, v1, vehicleClassId);
  await owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v1 });
  const v2 = await owner.client.mutation(clonePublishedVersionToDraft, { rateCardId });
  const rejectedUpdate: unknown = await owner.client
    // @ts-expect-error renumbering is deliberately absent from the version update API.
    .mutation(updateRateCardVersion, { rateCardVersionId: v2, currency: 'USD', versionNumber: 41 })
    .catch((error: unknown) => error);
  expect(rejectedUpdate).toBeInstanceOf(Error);
  expect(rejectedUpdate).not.toHaveProperty('data');
  await owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v2 });
  const v3 = await owner.client.mutation(clonePublishedVersionToDraft, { rateCardId });

  const versions = await owner.client.query(listRateCardVersions, { rateCardId, paginationOpts: firstPage });
  expect(versions.page.map((version) => [version._id, version.versionNumber, version.status])).toEqual([
    [v3, 3, 'draft'],
    [v2, 2, 'published'],
    [v1, 1, 'retired'],
  ]);
});

test('Rate Card detail finds a draft beyond the first history page', async () => {
  const { t, owner, organizationId, rateCardId } = await fixture('rate-cards-detail-late-draft');
  const draftVersionId = await t.run(async (ctx) => {
    for (let versionNumber = 1; versionNumber <= 30; versionNumber += 1) {
      await ctx.db.insert('rateCardVersions', {
        organizationId,
        rateCardId,
        versionNumber,
        currency: 'COP',
        status: 'retired',
      });
    }
    return ctx.db.insert('rateCardVersions', {
      organizationId,
      rateCardId,
      versionNumber: 31,
      currency: 'COP',
      status: 'draft',
    });
  });

  const firstHistoryPage = await owner.client.query(listRateCardVersions, {
    rateCardId,
    paginationOpts: { numItems: 25, cursor: null },
  });
  expect(firstHistoryPage.page).toHaveLength(25);
  const detail = await owner.client.query(getRateCardDetail, { rateCardId });
  expect(detail.draftVersion?._id).toBe(draftVersionId);
});

test('Rate Card detail returns the published Version, which is what the clone and retire actions need', async () => {
  // Without this, the whole resolution can be replaced by the constant `null`
  // and stay green — and `null` removes clone-published and retire from the
  // console entirely, replacing them with the create-first-draft picker.
  const { owner, rateCardId, versionId } = await publishedFixture('rate-cards-detail-published');
  const detail = await owner.client.query(getRateCardDetail, { rateCardId });
  expect(detail.publishedVersion?._id).toBe(versionId);
  expect(detail.publishedVersion?.status).toBe('published');
  expect(detail.publishedVersion?.versionNumber).toBe(1);
});

test('Rate Card detail returns null for a card whose Versions exist but none is published', async () => {
  // An earlier version of this test used a card with NO versions at all, so the
  // `currentPublishedVersionId === undefined` short-circuit fired and none of
  // the pointer's validity checks were ever reached.
  const { owner, rateCardId } = await fixture('rate-cards-detail-unpublished');
  const draftId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  const detail = await owner.client.query(getRateCardDetail, { rateCardId });
  expect(detail.draftVersion?._id).toBe(draftId);
  expect(detail.publishedVersion).toBeNull();
});

test('Rate Card detail refuses a current-published pointer that no longer resolves to a live published Version', async () => {
  const { t, owner, rateCardId, versionId } = await publishedFixture('rate-cards-detail-dangling');
  await t.run((ctx) => ctx.db.delete(versionId));
  expect((await owner.client.query(getRateCardDetail, { rateCardId })).publishedVersion).toBeNull();
});

test('Rate Card detail re-derives the published Version through the graph instead of trusting the pointer', async () => {
  // These three guards are I4: the stored pointer is a cache, and authorization
  // and identity walk the entity graph. None is reachable through a public
  // write today, which is exactly why each needs its own assertion — they were
  // written deliberately and nothing was checking them.
  const f = await publishedFixture('rate-cards-detail-pointer');
  const otherCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: f.organizationId,
    providerId: f.providerId,
    name: 'Another card',
  });
  const otherVersionId = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: otherCardId, currency: 'COP' });

  // Pointing at a version belonging to a DIFFERENT card.
  await f.t.run((ctx) => ctx.db.patch(f.rateCardId, { currentPublishedVersionId: otherVersionId }));
  expect((await f.owner.client.query(getRateCardDetail, { rateCardId: f.rateCardId })).publishedVersion).toBeNull();

  // Pointing at a version of this card that is NOT published.
  const draftOfThisCard = await f.t.run(async (ctx) =>
    ctx.db.insert('rateCardVersions', {
      organizationId: f.organizationId,
      rateCardId: f.rateCardId,
      versionNumber: 98,
      currency: 'COP',
      status: 'draft',
    }),
  );
  await f.t.run((ctx) => ctx.db.patch(f.rateCardId, { currentPublishedVersionId: draftOfThisCard }));
  expect((await f.owner.client.query(getRateCardDetail, { rateCardId: f.rateCardId })).publishedVersion).toBeNull();

  // Pointing at a version stamped with a foreign organization.
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Elsewhere',
    slug: 'rate-cards-detail-pointer-foreign',
  });
  const foreignStamped = await f.t.run(async (ctx) =>
    ctx.db.insert('rateCardVersions', {
      organizationId: foreignOrganizationId,
      rateCardId: f.rateCardId,
      versionNumber: 97,
      currency: 'COP',
      status: 'published',
    }),
  );
  await f.t.run((ctx) => ctx.db.patch(f.rateCardId, { currentPublishedVersionId: foreignStamped }));
  expect((await f.owner.client.query(getRateCardDetail, { rateCardId: f.rateCardId })).publishedVersion).toBeNull();
});

test('concurrent initial drafts produce one success and one conflict, leaving one number 1 draft', async () => {
  const { t, owner, rateCardId } = await fixture('rate-cards-concurrency');
  const outcomes = await Promise.allSettled([
    owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' }),
    owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'USD' }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ data: { code: 'conflict' } });
  }
  await t.run(async (ctx) => {
    const drafts = await ctx.db
      .query('rateCardVersions')
      .withIndex('by_card_status', (q) => q.eq('rateCardId', rateCardId).eq('status', 'draft'))
      .collect();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.versionNumber).toBe(1);
  });
});

test('publishing retires the previous version and advances the Card pointer atomically', async () => {
  const { owner, rateCardId, vehicleClassId } = await fixture('rate-cards-publish-transition');
  const v1 = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await addLine(owner.client, v1, vehicleClassId);
  await owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v1 });
  expect(await owner.client.query(getRateCard, { rateCardId })).toMatchObject({ currentPublishedVersionId: v1 });

  const v2 = await owner.client.mutation(clonePublishedVersionToDraft, { rateCardId });
  await owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v2 });
  const [card, first, second] = await Promise.all([
    owner.client.query(getRateCard, { rateCardId }),
    owner.client.query(getRateCardVersion, { rateCardVersionId: v1 }),
    owner.client.query(getRateCardVersion, { rateCardVersionId: v2 }),
  ]);
  expect(first.version.status).toBe('retired');
  expect(second.version.status).toBe('published');
  expect(card.currentPublishedVersionId).toBe(v2);
});

test('published Version currency edits are refused with rateCardVersionNotDraft', async () => {
  const { owner, versionId } = await publishedFixture('rate-cards-published-currency');
  await expect(owner.client.mutation(updateRateCardVersion, { rateCardVersionId: versionId, currency: 'USD' })).rejects.toMatchObject({
    data: { code: 'rateCardVersionNotDraft' },
  });
});

test('published grids refuse addRateLine with rateCardVersionNotDraft', async () => {
  const { owner, versionId, vehicleClassId } = await publishedFixture('rate-cards-published-add');
  await expect(owner.client.mutation(addRateLine, {
    rateCardVersionId: versionId,
    vehicleClassId,
    modality: 'fixed',
    unitAmount: 1,
  })).rejects.toMatchObject({ data: { code: 'rateCardVersionNotDraft' } });
});

test('published grids refuse updateRateLine with rateCardVersionNotDraft', async () => {
  const { owner, rateLineId } = await publishedFixture('rate-cards-published-update');
  await expect(owner.client.mutation(updateRateLine, { rateLineId, unitAmount: 1 })).rejects.toMatchObject({
    data: { code: 'rateCardVersionNotDraft' },
  });
});

test('published grids refuse removeRateLine with rateCardVersionNotDraft', async () => {
  const { owner, rateLineId } = await publishedFixture('rate-cards-published-remove');
  await expect(owner.client.mutation(removeRateLine, { rateLineId })).rejects.toMatchObject({
    data: { code: 'rateCardVersionNotDraft' },
  });
});

test('duplicate Class and modality cells are rejected', async () => {
  const { owner, rateCardId, vehicleClassId } = await fixture('rate-cards-duplicate');
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await addLine(owner.client, versionId, vehicleClassId);
  await expect(addLine(owner.client, versionId, vehicleClassId, 82_000_000)).rejects.toMatchObject({ data: { code: 'conflict' } });
});

test('unitAmount must pass the shared integer-minor-unit boundary', async () => {
  const { owner, rateCardId, vehicleClassId } = await fixture('rate-cards-money');
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await expect(addLine(owner.client, versionId, vehicleClassId, 1.5)).rejects.toMatchObject({ data: { code: 'moneyAmountNotInteger' } });
});

test('an empty Rate Card Version refuses publication', async () => {
  const { owner, rateCardId } = await fixture('rate-cards-empty');
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await expect(owner.client.mutation(publishRateCardVersion, { rateCardVersionId: versionId })).rejects.toMatchObject({
    data: { code: 'rateCardVersionEmpty' },
  });
});

test('an archived Card refuses publication', async () => {
  const { owner, rateCardId, vehicleClassId } = await fixture('rate-cards-publish-archived-card');
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await addLine(owner.client, versionId, vehicleClassId);
  await owner.client.mutation(archiveRateCard, { rateCardId });
  await expect(owner.client.mutation(publishRateCardVersion, { rateCardVersionId: versionId })).rejects.toMatchObject({
    data: { code: 'rateCardArchived' },
  });
});

test('a Version whose Provider became archived refuses publication', async () => {
  const { t, owner, rateCardId, providerId, vehicleClassId } = await fixture('rate-cards-publish-archived-provider');
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await addLine(owner.client, versionId, vehicleClassId);
  await t.run(async (ctx) => ctx.db.patch(providerId, { status: 'archived' }));
  await expect(owner.client.mutation(publishRateCardVersion, { rateCardVersionId: versionId })).rejects.toMatchObject({
    data: { code: 'rateCardProviderUnavailable' },
  });
});

test('a Version with an archived Class refuses publication', async () => {
  const { t, owner, rateCardId, vehicleClassId } = await fixture('rate-cards-publish-archived-class');
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await addLine(owner.client, versionId, vehicleClassId);
  await t.run(async (ctx) => ctx.db.patch(vehicleClassId, { status: 'archived' }));
  await expect(owner.client.mutation(publishRateCardVersion, { rateCardVersionId: versionId })).rejects.toMatchObject({
    data: { code: 'rateLineVehicleClassUnavailable' },
  });
});

test('a Version with a foreign Class refuses publication', async () => {
  const { t, owner, organizationId, rateCardId } = await fixture('rate-cards-publish-foreign-class');
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Foreign', slug: 'rate-cards-publish-foreign' });
  const foreignClassId = await owner.client.mutation(createVehicleClass, {
    organizationId: foreignOrganizationId,
    key: 'foreignClass',
    name: 'Foreign class',
  });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await t.run(async (ctx) => {
    await ctx.db.insert('rateLines', {
      organizationId,
      rateCardVersionId: versionId,
      vehicleClassId: foreignClassId,
      modality: 'fixed',
      unitAmount: 1,
    });
  });
  await expect(owner.client.mutation(publishRateCardVersion, { rateCardVersionId: versionId })).rejects.toMatchObject({
    data: { code: 'rateLineVehicleClassUnavailable' },
  });
});

test('publish independently rejects duplicate cells already present in a draft', async () => {
  const { t, owner, organizationId, rateCardId, vehicleClassId } = await fixture('rate-cards-publish-duplicate');
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await t.run(async (ctx) => {
    for (const unitAmount of [1, 2]) {
      await ctx.db.insert('rateLines', { organizationId, rateCardVersionId: versionId, vehicleClassId, modality: 'fixed', unitAmount });
    }
  });
  await expect(owner.client.mutation(publishRateCardVersion, { rateCardVersionId: versionId })).rejects.toMatchObject({
    data: { code: 'rateLineDuplicateCell' },
  });
});

test('resolveRate returns the stored line amount and Version currency without client arithmetic', async () => {
  const f = await publishedFixture('rate-cards-resolve-success');
  await expect(f.owner.client.query(resolveRate, {
    rateCardVersionId: f.versionId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).resolves.toEqual({ rateLineId: f.rateLineId, unitAmount: 81_000_000, currency: 'COP' });
});

test('resolveRate returns the generic error for an absent Class cell', async () => {
  const f = await publishedFixture('rate-cards-resolve-absent');
  const absentClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: f.organizationId,
    key: 'absentClass',
    name: 'Absent class',
  });
  await expect(f.owner.client.query(resolveRate, {
    rateCardVersionId: f.versionId,
    providerId: f.providerId,
    vehicleClassId: absentClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('resolveRate returns the generic error for a foreign Class even when a matching line exists', async () => {
  const f = await publishedFixture('rate-cards-resolve-foreign');
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, { name: 'Foreign', slug: 'rate-cards-resolve-foreign-org' });
  const foreignClassId = await f.owner.client.mutation(createVehicleClass, {
    organizationId: foreignOrganizationId,
    key: 'foreignClass',
    name: 'Foreign class',
  });
  await f.t.run(async (ctx) => {
    await ctx.db.insert('rateLines', {
      organizationId: f.organizationId,
      rateCardVersionId: f.versionId,
      vehicleClassId: foreignClassId,
      modality: 'fixed',
      unitAmount: 9,
    });
  });
  await expect(f.owner.client.query(resolveRate, {
    rateCardVersionId: f.versionId,
    providerId: f.providerId,
    vehicleClassId: foreignClassId,
    modality: 'fixed',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('resolveRate returns the generic error for the wrong Provider', async () => {
  const f = await publishedFixture('rate-cards-resolve-provider');
  const otherProviderId = await f.owner.client.mutation(createProvider, { organizationId: f.organizationId, name: 'Wrong Provider' });
  await expect(f.owner.client.query(resolveRate, {
    rateCardVersionId: f.versionId,
    providerId: otherProviderId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('resolveRate returns the generic error for an archived Card independently of version state', async () => {
  const f = await publishedFixture('rate-cards-resolve-archived');
  await f.t.run(async (ctx) => ctx.db.patch(f.rateCardId, { status: 'archived' }));
  await expect(f.owner.client.query(resolveRate, {
    rateCardVersionId: f.versionId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('resolveRate returns the generic error for a non-published Version independently of the Card pointer', async () => {
  const f = await fixture('rate-cards-resolve-draft');
  const versionId = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: f.rateCardId, currency: 'COP' });
  await addLine(f.owner.client, versionId, f.vehicleClassId);
  await f.t.run(async (ctx) => ctx.db.patch(f.rateCardId, { currentPublishedVersionId: versionId }));
  await expect(f.owner.client.query(resolveRate, {
    rateCardVersionId: versionId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('archiving preserves readable historical rows but refuses them for new pricing', async () => {
  const f = await publishedFixture('rate-cards-archive-history');
  const before = await f.owner.client.query(getRateCardVersion, { rateCardVersionId: f.versionId });
  await f.owner.client.mutation(archiveRateCard, { rateCardId: f.rateCardId });
  const after = await f.owner.client.query(getRateCardVersion, { rateCardVersionId: f.versionId });
  expect(after.version).toMatchObject({ _id: f.versionId, status: 'retired' });
  expect(after.rateLines).toEqual(before.rateLines);
  expect(after.rateLines[0]).toMatchObject({ _id: f.rateLineId, unitAmount: 81_000_000 });
  await expect(f.owner.client.mutation(createInitialDraftVersion, { rateCardId: f.rateCardId, currency: 'COP' })).rejects.toMatchObject({
    data: { code: 'rateCardArchived' },
  });
  await expect(f.owner.client.mutation(clonePublishedVersionToDraft, { rateCardId: f.rateCardId })).rejects.toMatchObject({
    data: { code: 'rateCardArchived' },
  });
  await expect(f.owner.client.query(resolveRate, {
    rateCardVersionId: f.versionId,
    providerId: f.providerId,
    vehicleClassId: f.vehicleClassId,
    modality: 'disposition',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
});

test('cross-organization Provider and Vehicle Class references are rejected', async () => {
  const { owner, organizationId, rateCardId } = await fixture('rate-cards-cross-org');
  const foreignOrganizationId = await owner.client.mutation(createOrganization, { name: 'Foreign', slug: 'rate-cards-cross-org-foreign' });
  const foreignProviderId = await owner.client.mutation(createProvider, { organizationId: foreignOrganizationId, name: 'Foreign Provider' });
  const foreignClassId = await owner.client.mutation(createVehicleClass, {
    organizationId: foreignOrganizationId,
    key: 'foreignClass',
    name: 'Foreign class',
  });
  await expect(owner.client.mutation(createRateCard, {
    organizationId,
    providerId: foreignProviderId,
    name: 'Cross tenant',
  })).rejects.toMatchObject({ data: { code: inaccessible } });
  const versionId = await owner.client.mutation(createInitialDraftVersion, { rateCardId, currency: 'COP' });
  await expect(addLine(owner.client, versionId, foreignClassId)).rejects.toMatchObject({ data: { code: inaccessible } });
  const ownClassId = await owner.client.mutation(createVehicleClass, {
    organizationId,
    key: 'ownClass',
    name: 'Own class',
  });
  const rateLineId = await addLine(owner.client, versionId, ownClassId);
  await expect(owner.client.mutation(updateRateLine, { rateLineId, vehicleClassId: foreignClassId })).rejects.toMatchObject({
    data: { code: inaccessible },
  });
});

test('Card and Version lists are tenant/card scoped and return a correct continuation page', async () => {
  const f = await fixture('rate-cards-pagination');
  const cardIds = [f.rateCardId];
  for (const name of ['Second Card', 'Third Card']) {
    cardIds.push(await f.owner.client.mutation(createRateCard, {
      organizationId: f.organizationId,
      providerId: f.providerId,
      name,
    }));
  }
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, { name: 'Foreign', slug: 'rate-cards-pagination-foreign' });
  const foreignProviderId = await f.owner.client.mutation(createProvider, { organizationId: foreignOrganizationId, name: 'Foreign Provider' });
  await f.owner.client.mutation(createRateCard, { organizationId: foreignOrganizationId, providerId: foreignProviderId, name: 'Foreign Card' });

  const firstCards = await f.owner.client.query(listRateCards, { organizationId: f.organizationId, paginationOpts: { numItems: 2, cursor: null } });
  expect(firstCards.page).toHaveLength(2);
  expect(firstCards.isDone).toBe(false);
  expect(firstCards.continueCursor).not.toBe('');
  const secondCards = await f.owner.client.query(listRateCards, { organizationId: f.organizationId, paginationOpts: { numItems: 2, cursor: firstCards.continueCursor } });
  expect(secondCards.page).toHaveLength(1);
  expect(secondCards.isDone).toBe(true);
  expect([...firstCards.page, ...secondCards.page].map((card) => card._id).sort()).toEqual([...cardIds].sort());
  expect([...firstCards.page, ...secondCards.page].every((card) => card.organizationId === f.organizationId)).toBe(true);

  const v1 = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: f.rateCardId, currency: 'COP' });
  await addLine(f.owner.client, v1, f.vehicleClassId);
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v1 });
  const v2 = await f.owner.client.mutation(clonePublishedVersionToDraft, { rateCardId: f.rateCardId });
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v2 });
  const v3 = await f.owner.client.mutation(clonePublishedVersionToDraft, { rateCardId: f.rateCardId });
  await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: cardIds[1]!, currency: 'USD' });

  const firstVersions = await f.owner.client.query(listRateCardVersions, { rateCardId: f.rateCardId, paginationOpts: { numItems: 2, cursor: null } });
  expect(firstVersions.page).toHaveLength(2);
  expect(firstVersions.isDone).toBe(false);
  const secondVersions = await f.owner.client.query(listRateCardVersions, { rateCardId: f.rateCardId, paginationOpts: { numItems: 2, cursor: firstVersions.continueCursor } });
  expect(secondVersions.page).toHaveLength(1);
  expect(secondVersions.isDone).toBe(true);
  expect([...firstVersions.page, ...secondVersions.page].map((version) => version._id)).toEqual([v3, v2, v1]);
  expect([...firstVersions.page, ...secondVersions.page].every((version) => version.rateCardId === f.rateCardId)).toBe(true);
});

test('Card list Provider filter returns only matching cards and a foreign Provider selects an empty page', async () => {
  const f = await fixture('rate-cards-provider-filter');
  const otherProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Other Provider',
  });
  const otherCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: f.organizationId,
    providerId: otherProviderId,
    name: 'Other terms',
  });
  const foreignOrganizationId = await f.owner.client.mutation(createOrganization, {
    name: 'Foreign',
    slug: 'rate-cards-provider-filter-foreign',
  });
  const foreignProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: foreignOrganizationId,
    name: 'Foreign Provider',
  });

  const matching = await f.owner.client.query(listRateCards, {
    organizationId: f.organizationId,
    providerId: otherProviderId,
    paginationOpts: firstPage,
  });
  expect(matching.page.map((card) => card._id)).toEqual([otherCardId]);
  expect(matching.page.every((card) => card.providerId === otherProviderId)).toBe(true);

  // A page's worth of cards belonging to somebody else, and only THEN the card
  // we filter for, so the match sits beyond the first page.
  //
  // Ordering is the whole point. With a handful of cards the two possible
  // implementations are indistinguishable: narrowing through the index and
  // filtering an already-fetched page return the same rows. Here they do not.
  // Filtering after `.paginate()` returns an EMPTY first page with `isDone`
  // false, because all ten rows it fetched belong to another provider — the I6
  // failure this query's own comment warns about, seen from the console as
  // "this provider has no rate cards".
  for (let index = 0; index < 12; index += 1) {
    await f.owner.client.mutation(createRateCard, {
      organizationId: f.organizationId,
      providerId: otherProviderId,
      name: `Bulk ${index}`,
    });
  }
  const lateProviderId = await f.owner.client.mutation(createProvider, {
    organizationId: f.organizationId,
    name: 'Late Provider',
  });
  const lateCardId = await f.owner.client.mutation(createRateCard, {
    organizationId: f.organizationId,
    providerId: lateProviderId,
    name: 'Late terms',
  });
  const beyondFirstPage = await f.owner.client.query(listRateCards, {
    organizationId: f.organizationId,
    providerId: lateProviderId,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(beyondFirstPage.page.map((card) => card._id)).toEqual([lateCardId]);
  expect(beyondFirstPage.isDone).toBe(true);

  const foreign = await f.owner.client.query(listRateCards, {
    organizationId: f.organizationId,
    providerId: foreignProviderId,
    paginationOpts: firstPage,
  });
  expect(foreign.page).toEqual([]);
  expect(foreign.isDone).toBe(true);
});

test('Card and Version lifecycle audit rows have the right actor/entity and contain no commercial grid', async () => {
  const f = await fixture('rate-cards-audit');
  await f.owner.client.mutation(updateRateCardMetadata, { rateCardId: f.rateCardId, name: 'Renamed terms' });
  const v1 = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: f.rateCardId, currency: 'COP' });
  await addLine(f.owner.client, v1, f.vehicleClassId);
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v1 });
  const v2 = await f.owner.client.mutation(clonePublishedVersionToDraft, { rateCardId: f.rateCardId });
  await f.owner.client.mutation(publishRateCardVersion, { rateCardVersionId: v2 });
  await f.owner.client.mutation(archiveRateCard, { rateCardId: f.rateCardId });

  await f.t.run(async (ctx) => {
    const auditsFor = (entityType: 'rateCard' | 'rateCardVersion', entityId: string) => ctx.db
      .query('auditEvents')
      .withIndex('by_org_entity', (q) => q.eq('organizationId', f.organizationId).eq('entityType', entityType).eq('entityId', entityId))
      .collect();
    const cardAudits = await auditsFor('rateCard', f.rateCardId);
    expect(cardAudits.map((audit) => audit.action)).toEqual(['rateCard.created', 'rateCard.updated', 'rateCard.archived']);
    expect(cardAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorUserId: f.owner.userId, entityType: 'rateCard', entityId: f.rateCardId, metadata: { name: 'TransAndes 2026', providerId: f.providerId } }),
      expect.objectContaining({ actorUserId: f.owner.userId, entityType: 'rateCard', entityId: f.rateCardId, metadata: { changedFields: 'name' } }),
      expect.objectContaining({ actorUserId: f.owner.userId, entityType: 'rateCard', entityId: f.rateCardId, metadata: { previousStatus: 'active' } }),
    ]));
    const v1Audits = await auditsFor('rateCardVersion', v1);
    expect(v1Audits.map((audit) => audit.action)).toEqual(['rateCardVersion.created', 'rateCardVersion.published', 'rateCardVersion.retired']);
    expect(v1Audits.map((audit) => audit.metadata)).toEqual([{ versionNumber: 1 }, { versionNumber: 1 }, { versionNumber: 1 }]);
    const v2Audits = await auditsFor('rateCardVersion', v2);
    expect(v2Audits.map((audit) => audit.action)).toEqual(['rateCardVersion.created', 'rateCardVersion.published', 'rateCardVersion.retired']);
    expect(v2Audits.map((audit) => audit.metadata)).toEqual([
      { versionNumber: 2, clonedFromVersion: 1 },
      { versionNumber: 2 },
      { versionNumber: 2 },
    ]);
    for (const audit of [...cardAudits, ...v1Audits, ...v2Audits]) {
      expect(audit.actorUserId).toBe(f.owner.userId);
      expect(JSON.stringify(audit.metadata)).not.toMatch(/unitAmount|rateLines|modality|currency/);
    }
  });
});

type SurfaceIds = {
  organizationId: Id<'organizations'>;
  rateCardId: Id<'rateCards'>;
  versionId: Id<'rateCardVersions'>;
  rateLineId: Id<'rateLines'>;
};

/**
 * Every public function in the domain, by its exported name.
 *
 * The name on each entry is not decoration: it feeds the compile-time
 * exhaustiveness check below, which is the only thing standing between this
 * suite and a new public door shipping untested. A hand-counted list had
 * exactly that failure — `getRateCardDetail` was added, the list stayed at
 * sixteen entries, and removing its authorization gate let an outsider read a
 * whole Rate Card with the suite green. `Object.keys` cannot help here: the
 * generated `api` is a proxy and enumerates to nothing at runtime, so the
 * check has to be a type-level one.
 */
function everyRateCardSurface(client: Client | SchemaTest, ids: SurfaceIds, providerId: Id<'providers'>, vehicleClassId: Id<'vehicleClasses'>) {
  return [
    { name: 'createRateCard', run: () => client.mutation(createRateCard, { organizationId: ids.organizationId, providerId, name: 'Blocked' }) },
    { name: 'updateRateCardMetadata', run: () => client.mutation(updateRateCardMetadata, { rateCardId: ids.rateCardId, name: 'Blocked' }) },
    { name: 'archiveRateCard', run: () => client.mutation(archiveRateCard, { rateCardId: ids.rateCardId }) },
    { name: 'createInitialDraftVersion', run: () => client.mutation(createInitialDraftVersion, { rateCardId: ids.rateCardId, currency: 'COP' }) },
    { name: 'clonePublishedVersionToDraft', run: () => client.mutation(clonePublishedVersionToDraft, { rateCardId: ids.rateCardId }) },
    { name: 'updateRateCardVersion', run: () => client.mutation(updateRateCardVersion, { rateCardVersionId: ids.versionId, currency: 'USD' }) },
    { name: 'addRateLine', run: () => client.mutation(addRateLine, { rateCardVersionId: ids.versionId, vehicleClassId, modality: 'fixed', unitAmount: 1 }) },
    { name: 'updateRateLine', run: () => client.mutation(updateRateLine, { rateLineId: ids.rateLineId, unitAmount: 1 }) },
    { name: 'removeRateLine', run: () => client.mutation(removeRateLine, { rateLineId: ids.rateLineId }) },
    { name: 'publishRateCardVersion', run: () => client.mutation(publishRateCardVersion, { rateCardVersionId: ids.versionId }) },
    { name: 'retireRateCardVersion', run: () => client.mutation(retireRateCardVersion, { rateCardVersionId: ids.versionId }) },
    { name: 'getRateCard', run: () => client.query(getRateCard, { rateCardId: ids.rateCardId }) },
    { name: 'getRateCardDetail', run: () => client.query(getRateCardDetail, { rateCardId: ids.rateCardId }) },
    { name: 'listRateCards', run: () => client.query(listRateCards, { organizationId: ids.organizationId, paginationOpts: firstPage }) },
    { name: 'listRateCardVersions', run: () => client.query(listRateCardVersions, { rateCardId: ids.rateCardId, paginationOpts: firstPage }) },
    { name: 'getRateCardVersion', run: () => client.query(getRateCardVersion, { rateCardVersionId: ids.versionId }) },
    { name: 'resolveRate', run: () => client.query(resolveRate, { rateCardVersionId: ids.versionId, providerId, vehicleClassId, modality: 'disposition' }) },
  ] as const;
}

/**
 * Adding a public query or mutation to `rateCards` without adding it above is a
 * `tsc` failure here, not a silently narrower test.
 */
type PublicRateCardFunction = keyof typeof api.rateCards.queries | keyof typeof api.rateCards.mutations;
type CoveredRateCardFunction = ReturnType<typeof everyRateCardSurface>[number]['name'];
const _everyPublicRateCardFunctionIsExercised: Exclude<
  PublicRateCardFunction,
  CoveredRateCardFunction
> extends never
  ? true
  : never = true;
void _everyPublicRateCardFunctionIsExercised;

test('every public rate card function is opaque to unauthenticated, fabricated-id, outsider, and below-role callers', async () => {
  const f = await fixture('rate-cards-opacity');
  const versionId = await f.owner.client.mutation(createInitialDraftVersion, { rateCardId: f.rateCardId, currency: 'COP' });
  const rateLineId = await addLine(f.owner.client, versionId, f.vehicleClassId);
  const real = { organizationId: f.organizationId, rateCardId: f.rateCardId, versionId, rateLineId };
  const missing = await f.t.run(async (ctx): Promise<SurfaceIds> => {
    const organizationId = await ctx.db.insert('organizations', { name: 'Gone', slug: 'rate-cards-gone' });
    const rateCardId = await ctx.db.insert('rateCards', { organizationId: f.organizationId, providerId: f.providerId, name: 'Gone', status: 'active' });
    const missingVersionId = await ctx.db.insert('rateCardVersions', { organizationId: f.organizationId, rateCardId: f.rateCardId, versionNumber: 99, currency: 'COP', status: 'draft' });
    const missingLineId = await ctx.db.insert('rateLines', { organizationId: f.organizationId, rateCardVersionId: versionId, vehicleClassId: f.vehicleClassId, modality: 'fixed', unitAmount: 1 });
    await ctx.db.delete(missingLineId);
    await ctx.db.delete(missingVersionId);
    await ctx.db.delete(rateCardId);
    await ctx.db.delete(organizationId);
    return { organizationId, rateCardId, versionId: missingVersionId, rateLineId: missingLineId };
  });
  const outsider = await provision(f.t, 'rate-cards-opacity-outsider');
  const planner = await provision(f.t, 'rate-cards-opacity-planner');
  await f.owner.client.mutation(addMember, { organizationId: f.organizationId, userId: planner.userId, role: 'planner' });

  for (const { name, run } of everyRateCardSurface(f.t, real, f.providerId, f.vehicleClassId)) {
    // The name rides along so a failure says which door opened, rather than
    // which index of an anonymous array did.
    await expect(run(), name).rejects.toMatchObject({ data: { code: unauthenticated } });
  }
  for (const caller of [outsider.client, planner.client]) {
    for (const { name, run } of everyRateCardSurface(caller, real, f.providerId, f.vehicleClassId)) {
      await expect(run(), name).rejects.toMatchObject({ data: { code: inaccessible } });
    }
  }
  for (const { name, run } of everyRateCardSurface(f.owner.client, missing, f.providerId, f.vehicleClassId)) {
    await expect(run(), name).rejects.toMatchObject({ data: { code: inaccessible } });
  }
});

test("a granted Provider Principal reaches no Card read or write, including its own Provider's Card", async () => {
  const f = await publishedFixture('rate-cards-provider-principal');
  const projectId = await f.owner.client.mutation(createProject, { organizationId: f.organizationId, name: 'Festival Cordillera' });
  const providerFirm = await provision(f.t, 'rate-cards-provider-firm');
  const providerOrganizationId = await providerFirm.client.mutation(createOrganization, {
    name: 'TransAndes',
    slug: 'rate-cards-provider-firm',
  });
  await f.t.run(async (ctx) => ctx.db.patch(f.providerId, { linkedOrganizationId: providerOrganizationId }));
  await f.owner.client.mutation(grantProjectAccessToProvider, { projectId, providerId: f.providerId });

  const ids = { organizationId: f.organizationId, rateCardId: f.rateCardId, versionId: f.versionId, rateLineId: f.rateLineId };
  for (const { name, run } of everyRateCardSurface(providerFirm.client, ids, f.providerId, f.vehicleClassId)) {
    await expect(run(), name).rejects.toMatchObject({ data: { code: inaccessible } });
  }
  await f.t.run(async (ctx) => {
    const grant = await ctx.db
      .query('providerAccessGrants')
      .withIndex('by_providerOrganization_project', (q) => q.eq('providerOrganizationId', providerOrganizationId).eq('projectId', projectId))
      .unique();
    expect(grant).toMatchObject({ status: 'active', providerId: f.providerId, organizationId: f.organizationId });
  });
});
