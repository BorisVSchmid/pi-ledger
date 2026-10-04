source("R/transmission.R")

# @concept P4
contact_rate <- function(t, beta0, amp) {
  beta0 * (1 + amp * cos(2 * pi * (t - 196) / 365))
}

derivs <- function(t, y, p) {
  with(as.list(c(y, p)), {
    N <- S + E + I + R
    beta <- contact_rate(t, beta0, amp)
    # @concept P2
    lambda <- foi(beta, I, N) + lambda_ext
    # @concept P3
    births <- mu * N
    dS <- births - lambda * S - mu * S
    dE <- lambda * S - sigma * E - mu * E
    dI <- sigma * E - gamma * I - mu * I
    dR <- gamma * I - mu * R
    list(c(dS, dE, dI, dR))
  })
}
