# Vector abundance input, monthly trap counts (already seasonal, July maximum)
vector_abundance <- function(t, traps) {
  approx(traps$day, traps$count, xout = t %% 365)$y
}
transmission_scale <- function(t, traps) {
  vector_abundance(t, traps) / mean(traps$count)
}
