# Model specification (human-owned; the agent proposes changes in its reply)

## P1 Transmission
- formulation: frequency-dependent  (FOI = beta * I / N)
- excluded: density-dependent
- units: beta [1/day]
- where: R/transmission.R, tagged `@concept P1`

## P2 External introduction
- mechanism: external hazard lambda_ext [1/day per susceptible]
- excluded: explicit external compartment
- where: tagged `@concept P2`

## P3 Demography
- births and background deaths only, one place each
- closure: closed
- where: tagged `@concept P3`

## P4 Seasonality
- mechanism: sinusoidal forcing on the contact rate, peak in July
- excluded: seasonality in any input series
- where: tagged `@concept P4`

## Units and time
- time step: daily; rates per day
