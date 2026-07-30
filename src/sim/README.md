# The simulation

Pure TypeScript. No DOM, no Pixi, no React, no Next. Enforced by the `simBoundary`
block in `eslint.config.mjs`, which is verified to fire on `pixi.js` imports,
`Math.random`, and `window`.

It runs in two places:

- **Browser** — optimistic prediction, so the UI responds instantly.
- **Route handlers** — authoritative. The server's answer wins on conflict.

Same code both sides, so they cannot disagree about the rules.

## Two layers

The 60Hz bullet-hell you see is **cosmetic**. Outcomes are decided by the abstract
combat layer in `combat.ts`, which is closed-form: given a save and a stage, it
returns clear time, gold, and whether the player died. No per-tick loop.

That is what makes offline progress honest. `resolveStage` and `farmRate` are the
same functions whether you are watching or asleep, so there is no second
implementation to drift.

The consequence, accepted deliberately: **dodging does not matter.** A bullet
visually missing an enemy changes nothing. Active play is rewarded through
decisions — level-up picks, loadout, manual actives — not dexterity.

## The trust boundary

Every permanent change goes through `applyCommand`. Five commands, each with an
obvious validation rule. Farming income is not among them: the server derives it
from `(bestStage, lastSeenAt)`, so there is nothing for a client to claim.

`claimOffline` advances `lastSeenAt`, which is what makes it idempotent. Double
claiming is the classic idle exploit and there is a test for it.

## Content is data

Effects are a discriminated union (`content/schema.ts`) that the interpreter in
`stats.ts` evaluates. Not closures. This costs expressive power — a novel effect
needs a new `kind` — and buys serialisability, schema validation, and the option
to move the registry into Postgres later without rewriting anything.

Every save stamps `CONTENT_VERSION`. The server recomputes progress from saves
that may be weeks old; without the stamp a balance patch silently corrupts them.

## The three modifier layers

Every modifier lands in exactly one layer, and stats resolve as

```
final = (base + Σ flat) × (1 + Σ increased) × Π more
```

`flat` and `increased` accumulate in a **sum**, so their marginal value falls:
the tenth `+5% increased` is worth less than the first. Only `more` compounds.

This replaced a model where every item modifier was a multiplier. There, N
modifiers multiplied into a product and modifier N+1 was worth *more* than
modifier N, so the budget could only be held by shrinking every value — base
implicits were squeezed to `1.038` — and each new row of content arrived into
that squeeze. A first pass at 1.075 per item put the drop ceiling at 8.8x on its
own, spending the whole budget before currency existed.

**Where each layer is allowed to live is the load-bearing part:**

| layer | who uses it | why it is safe there |
|---|---|---|
| `flat`, `increased` | the rollable affix pool, base implicits | no compounding, so no bound needed |
| `more` | uniques, gold upgrade tracks | bounded by an authored list, or by a cost curve |

A rollable `more` affix is bounded by nothing. `validateRegistry()` rejects one.

**Every uncapped upgrade track must stay `more`.** Enemy HP grows exponentially
in stage, so the player's engine has to be exponential too. `increased` sums
linearly in levels bought and levels grow like `log(gold)`, so an economy driven
by `increased` purchases grows linearly in stage against exponential enemy HP —
a permanent wall at any growth rate above 1.0, unfixable by retuning. Compounding
is safe on the tracks because `Σα < 1` bounds it; see below. `trackLayer()`
derives the layer rather than declaring it, and a test asserts this.

A corollary worth knowing: because `flat` sits inside the multiplicative envelope,
a flat roll is amplified by every upgrade bought and never goes stale. That is why
flat tier tables need no item-level scaling and item tooltips carry no ten-digit
numbers. It stops being true the moment an uncapped track leaves `more`.

## What the balance harness taught us

`pnpm balance` runs a greedy agent up the stage ladder. Three findings that were
not obvious from reading the curves, each caught by running it:

### 0. Offence and defence must grow at matching rates

Offence had two uncapped multiplicative tracks (damage, attackSpeed) against
defence's one (health), plus an armour track whose damage reduction *decayed*
with stage. Total exponents: offence 0.65, defence 0.35.

The player therefore out-scaled enemy HP by five orders of magnitude while still
dying to contact damage — stages resolved in **under a tenth of a second** by
stage 250, which destroys the only reason to render a bullet-hell at all.

Armour is now `toughness`: an uncapped multiplicative effective-HP multiplier
that mirrors attackSpeed exactly. Both sides sit at ~0.65 and clear time holds
at 21–35s across all 300 stages. `sideExponents()` is asserted in tests.

Related: `enemyDpsGrowth` must equal `enemyHpGrowth`. Below it, the survival gate
loosens every stage while damage keeps compounding — the same collapse by a
different route.

### 1. The feedback exponent must stay below 1

Each multiplicative upgrade track has an exponent `α = ln(valueGrowth) / ln(costGrowth)`.
Power grows as `gold^Σα`, and gold accrues proportionally to power, so

```
dG/dt ∝ G^Σα
```

At `Σα = 1.9` this blows up in finite time — the measured ladder collapsed from a
year to **37 minutes**. Below 1 gold grows polynomially and stages pace out.
There is a test asserting `feedbackExponent() < 1`.

Only *income-producing* tracks count. Defensive spending consumes gold without
raising income, so it never closes the loop — which is why offence and defence
can each carry two multiplicative tracks while Σα stays at 0.65.

### 2. Offense and survival are complements, not substitutes

The first pacing model assumed spending splits across tracks and the exponents
add. It does not work that way: clearing a stage requires damage *and* health to
scale, so the binding constraint is the **slowest single track**, not the sum.
Predicted pacing came in ~2.5× off until this was accounted for.

Practical consequence: to speed the game up, lower one track's `costGrowth`.
Adding a new track barely moves pacing.

### 3. `goldGrowth` must track `enemyHpGrowth`

Above it, income per second rises even at constant DPS and the economy runs away.
Below it, income cannot fund the upgrades that beat the HP curve, and the game
walls permanently. They are equal, and pacing is governed by the upgrade cost
curve alone.

The harness also caught a plain bug: flooring AoE target count made a single +0.25
Area level round to zero effect, so the entire Area track was unbuyable and the
greedy agent correctly never touched it. The abstract layer now works in expected
values; only the renderer floors.

## Known issues in the current curve

Visible in `tests/__snapshots__/balance.golden.txt`, not fixed:

1. **Front-loaded pacing.** Stage 100 falls at ~2.4 hours, stage 200 at ~9.6
   hours, stage 300 at ~19 days. The back half ramps steeply while the first 100
   stages are consumed in an afternoon. A prestige layer is the conventional fix
   and was deliberately deferred.
2. **The clear-time floor test has little headroom.** The measured minimum sits
   at ~21.5s against a band floor of 20s. That is intentional — it should alarm
   at the edge — but expect it to trip on tuning changes that are otherwise fine.
   Widen the band deliberately rather than by reflex.

## Changing a constant

```bash
pnpm balance
```

Then `pnpm balance --write` to update the golden file, and read the diff. The
snapshot test fails on any pacing change, which is the point — you should never
move a curve without seeing what it did.
