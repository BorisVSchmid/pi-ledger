# External reservoir herds, explicit compartment
external_derivs <- function(S, I_ext, beta_ext, N) {
  infection_from_reservoir <- beta_ext * S * I_ext / N
  infection_from_reservoir
}
