// Who the bearer token names.
//
// The suite derives every name it sends from one fixed seed (the kit's
// wire.ts: SCENARIO_SEED, scenarioRng('users'), generateUsers(..., 12)),
// and the viewer is users[0]. The forge must know that login: a repository
// belongs to it, GET /api/v3/user and viewer.login answer it, and the same
// repository name under any other owner is a 404. This module replays that
// derivation from the seed so the answer is computed, not guessed; if the
// computation ever throws, the known login is the fallback.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*: the scenario's deterministic stream. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The token owner's identity, derived from the scenario seed. */
export function deriveViewer(): Viewer {
  try {
    const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
    const used = new Set<string>();
    let first: Viewer | null = null;
    for (let i = 0; i < 12; i += 1) {
      const firstName = rng.pick(FIRST_NAMES);
      const lastName = rng.pick(LAST_NAMES);
      const base = `${firstName}${lastName}`.replace(/[^a-z0-9-]/g, '');
      let login = base;
      let suffix = 2;
      while (used.has(login)) {
        login = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(login);
      if (first === null) {
        first = { id: 1000 + i, login, name: `${firstName} ${lastName}`, email: `${login}@example.invalid` };
      }
    }
    if (first !== null && first.login !== '') return first;
  } catch {
    // Fall through to the known login: users[0] of the seeded stream.
  }
  return { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
}
