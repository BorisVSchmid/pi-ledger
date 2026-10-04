# Model specification (human-owned; the agent proposes changes in its reply)

One entry per process. State the abstraction once, name what is excluded, and
give the tag used in code (`# @concept P1`). The supervisor seeds its register
from this file and flags code that departs from it.

## P1 Transmission
- formulation: frequency-dependent  (FOI = β · I / N)
- excluded: density-dependent
- units: β [1/day]
- where: one function; tagged `@concept P1`

## P2 External introduction
- mechanism: external hazard λ_ext [1/day per susceptible]
- excluded: explicit external compartment
- where: tagged `@concept P2`

## P3 Demography
- births: <…>  deaths: background only | background + disease-induced (one place each)
- closure: closed | immigration allowed
- where: tagged `@concept P3`

## Units and time
- time step: <daily | weekly>; rates per <day>
- area units: <km²>

## Plausible ranges (for coherence type 6)
- R0: <lo–hi>   generation interval: <lo–hi days>   peak month: <…>   prevalence: <lo–hi>
