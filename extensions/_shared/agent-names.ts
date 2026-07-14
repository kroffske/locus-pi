/**
 * agent-names.ts — deterministic "petname" for a live agent row (REQ-002, D-002).
 *
 * Instead of an `agentName#a1b2c3` hash tail, every agent gets a memorable
 * scientist surname derived deterministically from its id (child-session uuid
 * when known, else the stable row id). Determinism means the same id always maps
 * to the same name across renders / resume without any state file; a
 * session-scoped registry appends `-2`, `-3`, … when two different ids happen to
 * hash to the same surname, so names stay unique within a session.
 *
 * The dictionary is intentionally a flat list of ~256 surnames: hashing an id to
 * an index is a pure function, and the list size only affects collision density,
 * not correctness (the registry resolves any collision deterministically).
 */

/**
 * ~256 scientist / mathematician surnames, each ≤ 12 columns so a petname fits
 * the row's name budget (REQ-001 width rule) without truncation. Order is stable:
 * changing it would re-map existing ids to different names, so append new names
 * at the end rather than inserting.
 */
export const SCIENTIST_NAMES: readonly string[] = [
  "Abel", "Adams", "Agnesi", "Ampere", "Anscombe", "Aristotle", "Avogadro", "Babbage",
  "Bacon", "Banneker", "Bardeen", "Bayes", "Becquerel", "Bell", "Bernoulli", "Bessel",
  "Bethe", "Bohr", "Boltzmann", "Boole", "Born", "Bose", "Boyle", "Bragg",
  "Brahe", "Brenner", "Brewster", "Bunsen", "Cajal", "Cannon", "Cantor", "Cardano",
  "Carnot", "Carson", "Carver", "Cauchy", "Cavendish", "Chadwick", "Chatelet", "Chladni",
  "Clausius", "Colombo", "Compton", "Comte", "Copernicus", "Coulomb", "Crick", "Curie",
  "Cuvier", "Dalton", "Darwin", "Davy", "Dedekind", "Descartes", "Dirac", "Doppler",
  "Draper", "Dyson", "Eddington", "Edison", "Ehrlich", "Einstein", "Elion", "Euclid",
  "Euler", "Faraday", "Fermat", "Fermi", "Feynman", "Fibonacci", "Fischer", "Fleming",
  "Fourier", "Franklin", "Fresnel", "Frisch", "Galilei", "Galois", "Galton", "Gamow",
  "Gauss", "Geiger", "Germain", "Gibbs", "Godel", "Goodall", "Gould", "Halley",
  "Hamilton", "Hardy", "Hawking", "Heaviside", "Heisenberg", "Helmholtz", "Henry", "Herschel",
  "Hertz", "Hilbert", "Hodgkin", "Hooke", "Hopper", "Hubble", "Humboldt", "Hutton",
  "Huxley", "Huygens", "Jacobi", "Jenner", "Joliot", "Joule", "Kapitsa", "Kepler",
  "Khayyam", "Kirchhoff", "Koch", "Krebs", "Lagrange", "Lamarck", "Landau", "Langevin",
  "Laplace", "Lavoisier", "Lawrence", "Leakey", "Leavitt", "Lebesgue", "Leclerc", "Legendre",
  "Leibniz", "Lemaitre", "Lenard", "Lenz", "Linnaeus", "Liouville", "Lister", "Lorentz",
  "Lorenz", "Lovelace", "Mach", "Maiman", "Malpighi", "Malthus", "Marconi", "Maxwell",
  "Mayer", "Meitner", "Mendel", "Mendeleev", "Mercator", "Michelson", "Millikan", "Minkowski",
  "Mobius", "Monod", "Morley", "Morse", "Moseley", "Napier", "Nash", "Nernst",
  "Neumann", "Newton", "Nobel", "Noether", "Oersted", "Ohm", "Onsager", "Ostwald",
  "Pascal", "Pasteur", "Pauli", "Pauling", "Pavlov", "Peano", "Pearson", "Penrose",
  "Perrin", "Planck", "Playfair", "Poincare", "Poisson", "Ptolemy", "Raman", "Ramanujan",
  "Ramsay", "Rayleigh", "Redi", "Reines", "Riemann", "Roentgen", "Russell", "Rutherford",
  "Rydberg", "Sabin", "Sagan", "Sakharov", "Salam", "Sanger", "Schwinger", "Seaborg",
  "Snell", "Somerville", "Stark", "Steno", "Stokes", "Tartaglia", "Teller", "Tesla",
  "Thales", "Thomson", "Torricelli", "Turing", "Tyson", "Volta", "Wallace", "Watson",
  "Watt", "Weber", "Wegener", "Wheeler", "Whitney", "Wigner", "Wilkins", "Witten",
  "Wozniak", "Wren", "Wright", "Yalow", "Yonath", "Young", "Yukawa", "Zeeman",
  "Zwicky",
];

/**
 * FNV-1a 32-bit string hash — a small, well-distributed, dependency-free hash so
 * that ids spread across the dictionary rather than clustering. `Math.imul`
 * keeps the multiply in 32-bit space; `>>> 0` returns an unsigned int.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic petname for an id (child-session uuid or row id). Pure: the same
 * id always yields the same surname; different ids almost always differ (bounded
 * only by dictionary size). Session-level uniqueness is layered on top by
 * {@link PetnameRegistry}.
 */
export function petname(id: string): string {
  const index = fnv1a(id) % SCIENTIST_NAMES.length;
  return SCIENTIST_NAMES[index] ?? SCIENTIST_NAMES[0]!;
}

/**
 * Session-scoped assignment of unique petnames. `assign` is idempotent per id
 * (same id → same name for the lifetime of the registry) and appends `-2`, `-3`,
 * … when a fresh id collides with a surname already handed out in this session,
 * so no two live rows share a name (REQ-002).
 */
export class PetnameRegistry {
  readonly #byId = new Map<string, string>();
  readonly #used = new Set<string>();

  assign(id: string): string {
    const existing = this.#byId.get(id);
    if (existing !== undefined) return existing;
    const base = petname(id);
    let candidate = base;
    let suffix = 2;
    while (this.#used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    this.#used.add(candidate);
    this.#byId.set(id, candidate);
    return candidate;
  }

  /** Release one retired row so bounded live-store pruning also bounds names. */
  release(id: string): boolean {
    const assigned = this.#byId.get(id);
    if (assigned === undefined) return false;
    this.#byId.delete(id);
    this.#used.delete(assigned);
    return true;
  }

  reset(): void {
    this.#byId.clear();
    this.#used.clear();
  }
}
