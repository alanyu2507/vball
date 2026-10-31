/** Seeded RNG (mulberry32). State is a single uint32 kept in the game state. */
export function rngNext(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Uniform in [-1, 1]. */
export function rngSigned(state: { rng: number }): number {
  return rngNext(state) * 2 - 1;
}
export function rngRange(state: { rng: number }, a: number, b: number): number {
  return a + (b - a) * rngNext(state);
}
