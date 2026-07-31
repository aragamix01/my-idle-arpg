/**
 * Unbounded magnitudes.
 *
 * A JS double dies at 1.8e308. That is not a precision problem to be tidied up - it is
 * a hard ceiling, and this ladder walks straight into it: enemy HP grows 1.12 per
 * stage, so `enemyHp` becomes Infinity somewhere near **stage 6,100** and every number
 * downstream of it becomes NaN. A game meant to run for years cannot have its
 * arithmetic quietly stop working at a stage number nobody chose.
 *
 * Gold hits a softer version of the same wall much earlier: past 2^53 (~stage 215) it
 * is no longer an exact integer, so `Math.floor` on it is theatre.
 *
 * ## What this buys, and what it does not
 *
 * RANGE, not precision. The mantissa is still a double, so about seventeen
 * significant digits survive and a cost eighteen orders of magnitude below your
 * balance still rounds away to nothing. That is deliberate and it is what every game
 * in this genre does: arbitrary-precision arithmetic in the hot path of a closed-form
 * sim, to charge a player 10 gold out of 1e40, is a cost with no gameplay attached.
 * There is a test pinning that behaviour so it stays a known trade rather than a
 * surprise.
 *
 * ## Why a mantissa-and-exponent type
 *
 * break_infinity.js stores a normalised double mantissa beside a double exponent, so
 * its range is about 10^(9e15). Stage 1e6 needs 10^49,218 for enemy HP - four orders of
 * magnitude of headroom in the EXPONENT alone. Layered types (OmegaNum and friends)
 * exist for games reaching 10^10^10 and would be dead weight here.
 *
 * ## Why this file exists rather than importing the package directly
 *
 * Every conversion in the game funnels through here, so the library is swappable: if
 * break_infinity is ever the wrong choice, this file changes and no game code moves.
 * It is the same indirection scripts/atlas/sources.ts uses for art, for the same
 * reason.
 *
 * ## Where Big must NOT go
 *
 * - **The renderer.** src/render runs at 60Hz on positions, seconds and fractions.
 *   Those are bounded by construction and Decimal arithmetic there would cost frames
 *   for no range.
 * - **RNG and content tables.** Affix values, tier magnitudes and rolls are small
 *   forever - an affix granting 5.5% cannot overflow anything.
 * - **Probabilities, counts and seconds.** Crit chance is clamped to 0..1, area is a
 *   target count, clear time is a number of seconds. A ratio of two enormous values is
 *   a small value, and that is exactly the case this type handles well.
 */

import Decimal from 'break_infinity.js';

export type Big = Decimal;

/** What a Big can be built from. Strings are the save format; numbers are literals. */
export type BigInput = Big | number | string;

export function big(value: BigInput): Big {
  return new Decimal(value);
}

export const BIG_ZERO = new Decimal(0);
export const BIG_ONE = new Decimal(1);

/**
 * Read a magnitude out of a save.
 *
 * Tolerates a raw number because that is what every save written before this type
 * existed holds. The migration rewrites them, but a value that slipped through must
 * load rather than throw - a save is someone's progress, not a schema exercise.
 */
export function fromSave(value: BigInput | null | undefined): Big {
  if (value === null || value === undefined) return BIG_ZERO;
  const parsed = new Decimal(value);
  // A malformed string parses to NaN, and a NaN magnitude silently poisons every
  // number it touches. Zero is wrong too, but it is wrong *visibly*.
  return isBad(parsed) ? BIG_ZERO : parsed;
}

/**
 * NaN, in either half of the representation.
 *
 * break_infinity carries a mantissa and an exponent as separate doubles and has no
 * isNaN of its own, so both have to be checked - a NaN exponent with a sane mantissa
 * formats as a plausible-looking number right up until it is compared with something.
 */
function isBad(value: Big): boolean {
  return !Number.isFinite(value.mantissa) || !Number.isFinite(value.exponent);
}

/**
 * Write a magnitude into a save, as a string.
 *
 * A string rather than a number, and not for tidiness: JSON numbers are IEEE doubles
 * on the way back in, which is precisely the thing being escaped. Postgres `jsonb`
 * would round-trip 1e5000 as Infinity. A string survives both, and is readable when
 * someone opens a save file to find out what went wrong.
 */
export function toSave(value: Big): string {
  return value.toString();
}

/**
 * Suffix names, in the range where names beat exponents.
 *
 * Stops at Q (1e18) on purpose. Past that the naming schemes stop being common
 * knowledge - nobody reads "sextillion" faster than they read "e21" - and any list is
 * finite, so it eventually runs out and starts printing 1000000.00Q.
 */
const SUFFIXES = ['', 'k', 'M', 'B', 'T', 'q', 'Q'] as const;
const NAMED_CEILING = 1e21;

/**
 * A magnitude as a human reads it: named below 1e21, scientific above.
 *
 * Lives here rather than in the UI layer because the sim needs it too - a refusal
 * saying "need 1.2e457 gold" is the same formatting problem as the HUD's, and two
 * implementations would drift the first time one was fixed.
 *
 * This function can never run out. That is the requirement it exists to meet.
 */
export function formatBig(value: Big): string {
  if (isBad(value)) return '-';
  if (value.lt(0)) return `-${formatBig(value.neg())}`;
  if (value.lt(1000)) {
    const n = value.toNumber();
    return n.toFixed(n < 10 && n % 1 !== 0 ? 1 : 0);
  }

  if (value.lt(NAMED_CEILING)) {
    const n = value.toNumber();
    const tier = Math.min(SUFFIXES.length - 1, Math.floor(Math.log10(n) / 3));
    return `${(n / Math.pow(1000, tier)).toFixed(2)}${SUFFIXES[tier]}`;
  }

  // Mantissa and exponent straight off the representation, so a value far past what a
  // double can hold formats exactly as cheaply as a small one.
  return `${value.mantissa.toFixed(2)}e${value.exponent}`;
}
