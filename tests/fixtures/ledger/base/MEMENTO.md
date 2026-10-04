# Does seasonal contact explain the July peak in herd prevalence?

Aim (human-owned; propose changes, do not edit):
Find out whether seasonal forcing of contact explains the July peak.

## Acceptance (locked)
- AC1: peak month within one month of observed on held-out years 2019-2021

## Assumptions
- A1: closed population, no immigration  — source: user  — status: untested
- A2: frequency-dependent transmission  — source: user  — status: untested

## Decisions
- D1: external introduction as a hazard, over an explicit external compartment  — reason: no data on the source population

## Checks (locked, written before the run)
- C1: R4 should show a July peak; fails if the peak is outside June-August

## Observed

## Crossed out
- ~~X1: transmission is density-dependent~~  — refuted by R2  — do not retry because: prevalence does not scale with herd size

## Next
- fit the model to 2015-2018  — done when: R4 posterior summary saved
