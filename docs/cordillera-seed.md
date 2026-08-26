# Cordillera operations seed

`seedCordilleraOperations` recreates a representative version of the 2026
Festival Cordillera ground-transport workbook in an existing Priamo
organization. It demonstrates published recipe snapshots, Bogotá absolute
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
bunx convex env remove PRIAMO_ENABLE_SEED
```

`projectName` is optional and defaults to `Cordillera 2026`.

## What a re-run does

Field definitions, recipes and locations are reused when they match what the
seed would itself have created; services and relationships are a clean-slate
set, and once the named project holds any service another run skips them
instead of duplicating.

Reuse is deliberately narrow. Several of the seeded keys — `driverName`,
`vehiclePlate`, `callTime`, `artist` — are ones a working tenant plausibly
already owns, and adopting one would be **irreversible**: publishing a seed
recipe against a tenant's own field definition permanently freezes that
definition's key, semantic type and config (I2/I3), because a published version
is never hard-deleted outside the development reset. So the seed matches on key
*and* config, and refuses with `seedFieldConflict` / `seedRecipeConflict`
rather than quietly taking ownership of configuration it did not author. The
refusal rolls the whole mutation back; nothing is left half-seeded.

## People and numbers are invented

The source workbook names real coordinators and drivers. Every person in this
seed is fictional and every telephone number is in the reserved `555` range. A
demonstration dataset that ships in an open repository must not carry anyone's
contact details.
