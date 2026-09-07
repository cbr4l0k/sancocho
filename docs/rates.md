# Money and rates

## Representation

Every money amount is an integer count of minor units paired with one of the
code-owned currencies `COP`, `USD`, `EUR`, or `MXN`. For example, COP 810,000 is
stored as `81000000` minor units. Persisted money must enter through the shared
currency validator and minor-unit assertion rather than through locale parsing.

Integer minor units make equality exact. Rates, agreed costs, and report totals
therefore compare and combine without binary floating-point fractions or drift.
Money code must never parse localized input with `Number()` and must never use
fractional arithmetic.

There is deliberately no per-currency exponent table yet. All four currencies
use the same integer-minor-unit representation; currency conversion, exchange
rates, and display formatting are separate future concerns.

## Exact-integer boundary

The supported magnitude is JavaScript's safe-integer interval. Persistable
amounts are non-negative integers from `0` through
`9,007,199,254,740,991` (`Number.MAX_SAFE_INTEGER`) minor units. A signed
difference may reach the corresponding negative boundary. JavaScript represents
every integer in this interval exactly, so equality is reliable. Inputs outside
the interval and arithmetic that would produce a result outside it are rejected
before that result can enter the money domain.

## Future conditional pricing attachment point

If structured conditional-pricing rules are introduced later, their attachment
point is the future rate entry within a published Rate Card Version, alongside
that entry's base money amount. They do not attach to the generic money value or
to these arithmetic helpers.

This document reserves only that location. No rule shape, evaluation mechanism,
formula language, expression DSL, surcharge engine, or conditional-pricing
implementation is defined or built here (I8).
