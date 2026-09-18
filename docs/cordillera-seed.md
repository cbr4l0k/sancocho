# Cordillera operations seed

`seedCordilleraOperations` recreates a representative version of the 2026
Festival Cordillera ground-transport workbook in an existing Priamo
organization. It demonstrates published service kind snapshots, Bogotá absolute
timestamps, typed service values, realistic lifecycle history, and links among
arrival, show, departure, passenger, and cargo services. The dataset covers the
STAGE 3, STAGE 4, CLUB COLOMBIA, OCESA, PROMOTORIA, MOV INTERNOS, and EQUIPO
sheets.

The extra Spanish operating fields — vehicle class, modality, tariff, billing
party, supplier status, driver details, and the rest — are organization-scoped
by design. They are tenant vocabulary composed alongside Priamo's built-in
location, passenger, flight, contact, and notes fields; they do not enlarge the
code-owned built-in catalogue.

Enable the guarded seed entry points, then run the internal mutation with the
slug of an organization that already has an owner:

```bash
cd apps/convex
bunx convex env set PRIAMO_ENABLE_SEED true
bunx convex run seed/cordillera:seedCordilleraOperations \
  '{"organizationSlug":"cordillera-demo","projectName":"Cordillera 2026"}'
bunx convex run seed/providerOrganization:seedProviderOrganizations \
  '{"organizationSlug":"cordillera-demo","projectName":"Cordillera 2026"}'
bunx convex env remove PRIAMO_ENABLE_SEED
```

`projectName` is optional on both and defaults to `Cordillera 2026`.

**Both commands, in that order.** The second one is not optional garnish: it is what gives the
demonstration a Provider *principal*, and without it `/portal/dispatch` has nobody to render for.

## The supply half

The workbook has two column sets, and the seed covers both. The left one — artists, parties, pickup
times, origins, destinations — is the operational half described above. The right one is where the
money and the accountability live:

- **Cost Centres** and **Vehicle Classes** derived from the workbook's own `Socio / cuenta` and
  `Clase de vehículo` option lists, so the typed catalogues carry the same vocabulary the
  spreadsheet column did. The tenant `select` field stays exactly as it was: the seed demonstrates
  both halves of that migration at once, the column as captured and the typed model that replaces it.
- **Two Providers**, `Transportes Andes SAS` and `Rutas del Altiplano SAS`, each with a published
  **Rate Card Version** priced by (Vehicle Class × modality) from the workbook's own figures, and
  **Fleet Vehicles** carrying the plates the Services already record.

  There are two rather than one because the workbook's figures are not a single grid: the crew
  shuttle prices H1 at 640 000 for every modality while the artist rows price H1 `trayecto` at
  185 000, and one published version cannot hold both cells. The crew shuttle is a different
  supplier, which is what the numbers were saying.
- **One Assignment per Service**, each with a commercial Revision resolved from the published Rate
  Card Version — never a figure the seed invented — plus execution state, checkpoints, and the
  workbook's `NO EJECUTADOS` and `ADICIONALES` adjustments.

  The execution states are deliberately spread across `unassigned`, `confirmed`, `dispatched`,
  `completed` and `notExecuted`, because a dispatch board whose every row is green demonstrates
  nothing.
- **A second, provider-side Organization per firm**, reached through the ordinary invite → claim →
  grant handshake rather than by writing the link directly. `Transportes Andes` is granted the
  Cordillera project; `Rutas del Altiplano` is claimed and deliberately **not** granted, so the
  portal's refusal of it is a live demonstration that the grant — not the Provider row, and not the
  claim — is what admits a principal.

The Event carries the workbook's budget of 110 000 000 COP. Committed lands near 45 520 000: the
seeded dataset is a representative subset, and the gap between the two is the comparison a budget
surface exists to make.

### Money units

Workbook figures are whole pesos; every stored amount is integer **minor units** (COP, exponent 2).
The seed crosses that boundary through one helper. A missing `× 100` still typechecks, so
`tests/seed-supply.test.ts` asserts specific rate lines hold minor units — that assertion is the
only thing standing between the demo and a silent hundredfold error.

## What the development reset sweeps

`resetTenantOperations` deletes the commercial tables too — assignments, revisions, checkpoints,
grants, rate cards and their lines, fleet vehicles, vehicle classes, cost centres, providers, and
the Provider-claim invitations that point at them — child-before-parent, ahead of the Services.

That is a correctness requirement, not tidiness. Leaving them would delete the Services while
`assignments` still pointed at ids that no longer resolve, and those orphans are reachable:
`listProjectAssignments` and `assignmentsAwaitingDispatch` key off the project, which the reset
deliberately preserves. Each orphan also carries an accepted revision with a real amount, and each
one permanently blocks deletion of its Cost Centre, Fleet Vehicle and Provider.

Vehicle Classes are swept as well, which is only safe because both seeds now call
`provisionStarterVehicleClasses` themselves. Starter classes used to be provisioned only at
organization creation — which a reset never re-runs — so sweeping them without that change would
have left the tenant permanently without a catalogue.

## What a re-run does

Field definitions, service kinds and locations are reused when they match what the
seed would itself have created; services and relationships are a clean-slate
set, and once the named project holds any service another run skips them
instead of duplicating.

Reuse is deliberately narrow. Several of the seeded keys — `driverName`,
`vehiclePlate`, `callTime`, `artist` — are ones a working tenant plausibly
already owns, and adopting one would be **irreversible**: publishing a seed
service kind against a tenant's own field definition permanently freezes that
definition's key, semantic type and config (I2/I3), because a published version
is never hard-deleted outside the development reset. So the seed matches on key
*and* config, and refuses with `seedFieldConflict` / `seedServiceKindConflict`
rather than quietly taking ownership of configuration it did not author. The
refusal rolls the whole mutation back; nothing is left half-seeded.

## People and numbers are invented

The source workbook names real coordinators and drivers. Every person in this
seed is fictional and every telephone number is in the reserved `555` range. A
demonstration dataset that ships in an open repository must not carry anyone's
contact details.
