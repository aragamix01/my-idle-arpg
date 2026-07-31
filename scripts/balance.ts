/**
 * Balance harness.
 *
 * Runs a greedy "spend gold optimally" agent through the stage ladder and
 * prints time-to-clear per stage. This is the only honest way to know whether
 * the curves in src/sim/curves.ts intersect the way they should - you cannot
 * feel out 300 stages by playing.
 *
 *   pnpm balance              # print the table
 *   pnpm balance --write      # update the golden snapshot
 *
 * Commit the golden file. When you change a constant, the diff shows you
 * exactly how pacing moved.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  applyCommand,
  applyCurrencyToItem,
  availableTiers,
  CURRENCIES,
  currencyLegality,
  DISSEMBLE_YIELD,
  farmRate,
  formatBig,
  fromSave,
  getAffix,
  getCurrency,
  INVENTORY_CAP,
  isUpgradeMaxed,
  ITEM_SLOTS,
  isWeaponBase,
  itemPower,
  newSave,
  rerollAffixes,
  rerollCost,
  resolveDungeon,
  resolveStage,
  rollDropCount,
  rollItem,
  rollStageBossDrops,
  STAGE_TIME_LIMIT_SECONDS,
  toSave,
  upgradeCost,
  UPGRADE_KEYS,
  type Big,
  type CurrencyId,
  type SaveState,
  type UpgradeKey,
} from '../src/sim';

const MAX_STAGE = 300;
const SEED = 0xc0ffee;
/**
 * How long the agent will farm for a single upgrade before declaring the run
 * stalled. This is a statement about player patience, not a technical limit -
 * if the model says the next upgrade is 40 days of farming, that stage is a
 * wall whether or not the arithmetic terminates.
 */
const PATIENCE_SECONDS = 21 * 24 * 3600;
const GOLDEN_PATH = resolve(process.cwd(), 'tests/__snapshots__/balance.golden.txt');

/** How close the agent is to beating a stage. >1 means it clears. */
function clearScore(save: SaveState, stage: number): number {
  const o = resolveStage(save, stage);
  const survival = 1 / Math.max(o.damageTakenFraction, 1e-9);
  const speed = STAGE_TIME_LIMIT_SECONDS / Math.max(o.seconds, 1e-9);
  return Math.min(survival, speed);
}

/** Objective the greedy agent maximises: beat the stage, and farm faster. */
function value(save: SaveState, stage: number): number {
  return Math.log(clearScore(save, stage)) + 0.5 * Math.log(farmRate(save, save.bestStage) + 1);
}

function withUpgrade(save: SaveState, key: UpgradeKey): SaveState {
  return { ...save, upgrades: { ...save.upgrades, [key]: save.upgrades[key] + 1 } };
}

interface Purchase {
  key: UpgradeKey;
  cost: Big;
  gain: number;
}

function bestPurchase(save: SaveState, stage: number): Purchase | null {
  const before = value(save, stage);
  let best: Purchase | null = null;

  for (const key of UPGRADE_KEYS) {
    const level = save.upgrades[key];
    if (isUpgradeMaxed(key, level)) continue;
    const cost = upgradeCost(key, level);
    const delta = value(withUpgrade(save, key), stage) - before;
    if (delta <= 0) continue;
    // Compared in log space: late-game costs exceed 1e300, and a raw
    // delta/cost ratio underflows to zero for every candidate, which the
    // harness would otherwise report as a wall that does not exist.
    const gain = Math.log(delta) - cost.ln();
    if (best === null || gain > best.gain) best = { key, cost, gain };
  }
  return best;
}

export interface Row {
  stage: number;
  attempts: number;
  cumulativeSeconds: number;
  stageSeconds: number;
  clearSeconds: number;
  goldPerSecond: number;
  totalLevels: number;
}

/** Printed when the agent stalls, so a wall report is actionable rather than mysterious. */
function diagnose(save: SaveState, stage: number): string {
  const o = resolveStage(save, stage);
  const before = value(save, stage);
  const lines = [
    `  outcome: cleared=${o.cleared} failure=${o.failure} seconds=${o.seconds.toFixed(2)} ` +
      `damageTaken=${o.damageTakenFraction.toFixed(3)} trash=${o.trashPhaseSeconds.toFixed(2)}s ` +
      `boss=${o.bossPhaseSeconds.toFixed(2)}s`,
    `  gold=${formatBig(fromSave(save.gold))} value=${before.toFixed(4)} farm=${farmRate(save, save.bestStage).toExponential(2)}`,
  ];
  for (const key of UPGRADE_KEYS) {
    const level = save.upgrades[key];
    const maxed = isUpgradeMaxed(key, level);
    const delta = maxed ? NaN : value(withUpgrade(save, key), stage) - before;
    lines.push(
      `  ${key.padEnd(12)} lvl=${String(level).padStart(4)} ` +
        `${maxed ? 'MAXED' : `cost=${upgradeCost(key, level).toExponential(2)} delta=${delta.toExponential(3)}`}`,
    );
  }
  return lines.join('\n');
}

/**
 * Take a clear's drops, discarding the weakest unequipped item when full.
 *
 * Modelled directly rather than through applyCommand because the harness also
 * wants the timing figures resolveStage returns, and calling both would roll
 * the stage twice. It does share rollDropCount, so it sees the same number of
 * items a real clear hands out.
 *
 * The agent never lets its inventory block a drop - it always makes room. A
 * player who hoards until full is strictly worse off, and modelling the worse
 * player would make the ladder look harder than it is.
 */
function takeDrop(save: SaveState, stage: number): SaveState {
  let owned = [...save.items];
  const firstUid = save.nextItemId;
  let uid = firstUid;
  const drops = rollDropCount(save.seed, firstUid);
  const currency = { ...save.currency };

  // Fragments and keys come off the same clear-seeded stream the real command
  // uses, so the harness sees the crafting income a real player sees.
  for (const [id, count] of Object.entries(rollStageBossDrops(save.seed, firstUid, stage)) as [
    CurrencyId,
    number,
  ][]) {
    currency[id] = (currency[id] ?? 0) + count;
  }

  for (let i = 0; i < drops; i++) {
    if (owned.length >= INVENTORY_CAP) {
      // Dissemble rather than delete: the weakest spare is now raw material,
      // and an agent that threw it away would model a player who ignores half
      // the crafting economy.
      // The equipped weapon is never a spare. It is the single most valuable item
      // the agent owns - it carries the skill and the skill level - so dissembling
      // it to make room for a common would model a player with a death wish.
      const spare = owned
        .filter((item) => !save.loadout.includes(item.uid) && item.uid !== save.weapon)
        .sort((a, b) => itemPower(a) - itemPower(b))[0];
      if (!spare) break;
      owned = owned.filter((item) => item.uid !== spare.uid);
      const yielded = DISSEMBLE_YIELD[spare.rarity];
      currency[yielded] = (currency[yielded] ?? 0) + 1;
    }
    owned.push(rollItem(save.seed, uid, stage));
    uid++;
  }

  return { ...save, items: owned, currency, nextItemId: uid };
}

/**
 * Spend keys on dungeons.
 *
 * Only when the dungeon is actually winnable - a loss costs the key and pays
 * nothing, and an agent that threw keys at a boss it could not kill would model
 * a player who never learns. resolveDungeon is pure, so checking first is not
 * foresight about a random roll; it is the same reasoning a player does by
 * looking at their own numbers.
 *
 * Returns the elapsed seconds alongside the new state, because a dungeon is
 * time spent and the ladder's pacing has to account for it.
 */
function runDungeons(save: SaveState): { save: SaveState; seconds: number } {
  let current = save;
  let seconds = 0;

  for (let i = 0; i < 50; i++) {
    if ((current.currency['dungeon-key'] ?? 0) < 1) break;
    if (!resolveDungeon(current, current.bestStage).cleared) break;

    const before = current;
    const result = applyCommand(current, { type: 'attemptDungeon' }, 0);
    if (!result.ok) break;
    current = result.value.state;

    const cleared = result.value.events.find((e) => e.type === 'dungeonCleared');
    seconds += cleared && cleared.type === 'dungeonCleared' ? cleared.seconds : 0;
    // Defensive: a command that consumed nothing would loop forever.
    if (current.currency['dungeon-key'] === before.currency['dungeon-key']) break;
  }

  return { save: current, seconds };
}

/** Spend ten fragments whenever ten have accumulated. */
function combineAll(save: SaveState): SaveState {
  const currency = { ...save.currency };
  let changed = true;

  while (changed) {
    changed = false;
    for (const definition of CURRENCIES) {
      const action = definition.action;
      if (action.kind !== 'combine') continue;
      const held = currency[definition.id] ?? 0;
      if (held < action.count) continue;
      currency[definition.id] = held - action.count;
      currency[action.into] = (currency[action.into] ?? 0) + 1;
      changed = true;
    }
  }

  return { ...save, currency };
}

/**
 * How far an item's rolled affixes are from their best possible tiers, 0..1.
 *
 * The decision input for the currencies that reroll magnitudes. Zero means
 * every modifier is already top tier and there is nothing to gain.
 */
function tierHeadroom(item: SaveState['items'][number]): number {
  if (item.affixes.length === 0) return 0;
  const shortfall = item.affixes.reduce((sum, rolled) => {
    const affix = getAffix(rolled.affixId);
    if (!affix) return sum;
    const best = availableTiers(affix, item.itemLevel).at(-1) ?? 0;
    return sum + (best - rolled.tier) / Math.max(1, best);
  }, 0);
  return shortfall / item.affixes.length;
}

/**
 * Spend crafting currency on the loadout.
 *
 * **The agent must decide before it sees the result.** Every roll here is a
 * pure function of (seed, uid, crafts), so an agent could apply a currency,
 * measure the outcome, and keep only the good ones - and would then model a
 * player with perfect foresight, overstating crafting by an unknowable margin.
 * Every rule below is a heuristic on the item's *current* state, and whatever
 * comes back is kept. That is the same rule the gold reroll already follows:
 * "the result is kept whatever it is".
 *
 * It will not gamble. An Angel Droplet destroys the item nine times in ten, and
 * an agent with no way to value a one-in-ten unique would just feed it commons.
 */
function spendCurrency(save: SaveState, stage: number): SaveState {
  let current = combineAll(save);

  const spend = (id: CurrencyId, item: SaveState['items'][number]): boolean => {
    const definition = getCurrency(id);
    if (!definition) return false;
    if ((current.currency[id] ?? 0) < 1) return false;
    if (currencyLegality(item, definition, true)) return false;

    const result = applyCurrencyToItem(current.seed, item, definition);
    current = {
      ...current,
      currency: { ...current.currency, [id]: (current.currency[id] ?? 0) - 1 },
      items: result.item
        ? current.items.map((c) => (c.uid === item.uid ? result.item! : c))
        : current.items.filter((c) => c.uid !== item.uid),
    };
    return true;
  };

  for (let pass = 0; pass < 8; pass++) {
    /**
     * Craft the best *craftable* items, equipped or not.
     *
     * Not just the loadout. Crafting only what is equipped is a trap the first
     * cut fell into: uniques cannot be crafted, the agent equipped four of
     * them because an uncrafted rare loses to a unique, and then nothing was
     * ever a legal craft target - it finished the ladder holding 19 unspent
     * Rare Ore. A rare has to be allowed to become better than a unique before
     * it will ever be equipped, which means crafting it on the bench first.
     */
    const candidates = current.items
      .filter((item) => item.rarity !== 'unique')
      .sort(
        (a, b) => b.itemLevel - a.itemLevel || itemPower(b) - itemPower(a),
      )
      .slice(0, ITEM_SLOTS * 2);
    let acted = false;

    for (const item of candidates) {
      // Rarity upgrades are the one unambiguous win: existing modifiers
      // survive and a new row is added. Always worth taking.
      if (item.rarity === 'common' && spend('magic-ore', item)) {
        acted = true;
        continue;
      }
      if (item.rarity === 'magic' && spend('rare-ore', item)) {
        acted = true;
        continue;
      }

      // A spirit is permanent and one-shot, so spend it on something already
      // worth keeping rather than the first rare that comes along.
      if (
        item.rarity === 'rare' &&
        !item.spirit &&
        item.uid === candidates[0]?.uid &&
        (spend('dune-spirit', item) || spend('bishop-spirit', item) || spend('devil-spirit', item))
      ) {
        acted = true;
        continue;
      }

      // Flames fix magnitudes, idols fix modifiers. Both only when there is
      // measurable room - an item already at top tier has nothing to gain and
      // spending on it would model a player burning currency for nothing.
      if (tierHeadroom(item) > 0.25 && spend('angel-flame', item)) {
        acted = true;
        continue;
      }
      if (tierHeadroom(item) > 0.4 && (spend('sacred-idol', item) || spend('dark-idol', item))) {
        acted = true;
      }
    }

    if (!acted) break;
    current = improveLoadout(current, stage);
  }

  return improveLoadout(current, stage);
}

/**
 * How many bench items the agent will weigh against a slot.
 *
 * Not the whole inventory. Every candidate costs a resolveStage through
 * value(), so an exhaustive search is O(slots x items x passes) per clear -
 * which at a 200-slot inventory pushed the golden-snapshot test past its
 * timeout. It is also a poor model: a player triages by eye and tries the
 * promising few, rather than evaluating two hundred items against four slots.
 */
const LOADOUT_CANDIDATES = 24;

/**
 * Equip whatever raises the objective.
 *
 * Repeated single swaps rather than a search over all combinations - the
 * agent is greedy everywhere else and this keeps it comparable.
 */
function improveLoadout(save: SaveState, stage: number): SaveState {
  let current = save;

  for (let pass = 0; pass < ITEM_SLOTS * 2; pass++) {
    const baseline = value(current, stage);
    let best: { save: SaveState; gain: number } | null = null;

    // Ranked by the same crude heuristic the discard logic uses. It can miss an
    // item that is weak overall but ideal for this build; that is the cost of
    // not evaluating everything, and 24 candidates for 4 slots is generous.
    const candidates = [...current.items]
      .sort((a, b) => itemPower(b) - itemPower(a))
      .slice(0, LOADOUT_CANDIDATES);

    for (let slot = 0; slot < ITEM_SLOTS; slot++) {
      for (const item of candidates) {
        if (current.loadout.includes(item.uid)) continue;
        if (isWeaponBase(item.baseId)) continue; // weapons have their own slot
        const loadout = [...current.loadout];
        loadout[slot] = item.uid;
        const candidate = { ...current, loadout };
        const gain = value(candidate, stage) - baseline;
        if (gain > 0 && (!best || gain > best.gain)) best = { save: candidate, gain };
      }
    }

    // The weapon is weighed separately, and against every weapon owned rather than
    // only the top-ranked candidates. It has to be: a weapon decides the skill, so
    // swapping it changes which stats matter at all, and itemPower cannot rank an
    // Axe against a Wand in a way that means anything. Weapons are also a fifth of
    // drops rather than a whole inventory, so the exhaustive pass stays cheap.
    for (const item of current.items) {
      if (!isWeaponBase(item.baseId) || current.weapon === item.uid) continue;
      const candidate = { ...current, weapon: item.uid };
      const gain = value(candidate, stage) - baseline;
      if (gain > 0 && (!best || gain > best.gain)) best = { save: candidate, gain };
    }

    if (!best) break;
    current = best.save;
  }

  return current;
}

/**
 * Gamble on a reroll when gold is plentiful.
 *
 * A reroll's outcome is unknowable in advance, so the agent cannot evaluate it
 * the way it evaluates an upgrade. It rerolls the weakest equipped non-unique
 * only when it can comfortably afford to - the 4x multiplier assumes a player
 * who chases rolls, and ignoring rerolling entirely would model someone who
 * never touches the system.
 */
function maybeReroll(save: SaveState, stage: number): SaveState {
  const equipped = save.items.filter(
    (item) => save.loadout.includes(item.uid) && item.rarity !== 'unique',
  );
  if (equipped.length === 0) return save;

  const weakest = equipped.sort((a, b) => itemPower(a) - itemPower(b))[0];
  const cost = rerollCost(weakest.rarity, weakest.itemLevel, weakest.rerolls);
  // Never starve the upgrade tracks: rerolling is discretionary spending.
  if (fromSave(save.gold).lt(cost.mul(4))) return save;

  const rerolled = rerollAffixes(save.seed, weakest);
  const next: SaveState = {
    ...save,
    gold: toSave(fromSave(save.gold).sub(cost)),
    items: save.items.map((item) => (item.uid === weakest.uid ? rerolled : item)),
  };
  // The result is kept whatever it is - that is what "cannot remove if it
  // broke" means. Re-equipping afterwards may drop it for something better.
  return improveLoadout(next, stage);
}

/**
 * @param seed Account seed. Defaults to the fixed one the golden is recorded under.
 *
 * Parameterised because a single trajectory cannot tell a pacing CHANGE from drop
 * luck: uniques are 2% of drops and one of them carries a large gold multiplier, so
 * whether the agent happens to find it moves total elapsed time by a factor of two.
 * Sweeping seeds is how that question gets answered instead of argued about.
 */
export function runLadder(seed = SEED): {
  rows: Row[];
  wall: number | null;
  diagnosis: string;
  stallReason: string;
  /** Final agent state, so a probe can ask what it actually did with its loot. */
  finalSave: SaveState;
} {
  let save = newSave(seed, 0);
  let elapsed = 0;
  const rows: Row[] = [];

  for (let stage = 1; stage <= MAX_STAGE; stage++) {
    const stageStart = elapsed;
    let attempts = 0;
    let stalled = false;
    let stallReason = 'no purchase improves the outcome';

    for (;;) {
      const outcome = resolveStage(save, stage);
      attempts++;
      elapsed += Math.min(outcome.seconds, STAGE_TIME_LIMIT_SECONDS);
      save = { ...save, gold: toSave(fromSave(save.gold).add(outcome.goldEarned)) };

      if (outcome.cleared) {
        save = { ...save, bestStage: stage, currentStage: stage + 1 };
        save = takeDrop(save, stage);
        save = improveLoadout(save, stage);
        // Dungeons before crafting: they are where finished currency and the
        // only spirits come from, so spending keys first is what gives the
        // crafting pass something to spend.
        const dungeons = runDungeons(save);
        save = dungeons.save;
        elapsed += dungeons.seconds;
        save = spendCurrency(save, stage);
        break;
      }

      // Buy everything currently affordable that helps.
      let boughtAnything = false;
      for (;;) {
        const buy = bestPurchase(save, stage);
        if (!buy || buy.cost.gt(fromSave(save.gold))) break;
        save = {
          ...withUpgrade(save, buy.key),
          gold: toSave(fromSave(save.gold).sub(buy.cost)),
        };
        boughtAnything = true;
      }

      save = maybeReroll(save, stage);

      if (!boughtAnything) {
        // Farm at the best cleared stage until the next useful upgrade is affordable.
        const buy = bestPurchase(save, stage);
        const rate = farmRate(save, save.bestStage);
        if (!buy) {
          stalled = true;
          break;
        }
        if (rate <= 0) continue; // no farm income yet; keep re-attempting for partial gold
        // Divided as Bigs and only then collapsed to a number of seconds. The deficit
        // and the rate are both astronomical late on; their RATIO is a normal number,
        // which is exactly the shape this type handles and a double cannot.
        const seconds = fromSave(save.gold).sub(buy.cost).neg().div(rate).toNumber();
        if (!Number.isFinite(seconds) || seconds > PATIENCE_SECONDS) {
          stalled = true;
          stallReason = `next upgrade (${buy.key}) costs ${formatBig(buy.cost)} at ${rate.toExponential(2)} gold/s = ${fmtDuration(seconds)} of farming`;
          break;
        }
        elapsed += seconds;
        save = { ...save, gold: toSave(fromSave(save.gold).add(rate * seconds)) };
      }

      if (attempts > 5000) {
        stalled = true;
        break;
      }
    }

    if (stalled) return { rows, wall: stage, diagnosis: diagnose(save, stage), stallReason, finalSave: save };

    rows.push({
      stage,
      attempts,
      cumulativeSeconds: elapsed,
      stageSeconds: elapsed - stageStart,
      clearSeconds: resolveStage(save, stage).seconds,
      goldPerSecond: farmRate(save, stage),
      totalLevels: UPGRADE_KEYS.reduce((n, k) => n + save.upgrades[k], 0),
    });
  }

  return { rows, wall: null, diagnosis: '', stallReason: '', finalSave: save };
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function report(): string {
  const { rows, wall, diagnosis, stallReason } = runLadder();
  const lines: string[] = [];

  lines.push('stage |  attempts | time in stage | total elapsed | clear time |    gold/s | levels');
  lines.push('------+-----------+---------------+---------------+------------+-----------+-------');

  for (const r of rows) {
    const milestone = r.stage <= 10 || r.stage % 10 === 0;
    if (!milestone) continue;
    lines.push(
      [
        String(r.stage).padStart(5),
        String(r.attempts).padStart(10),
        fmtDuration(r.stageSeconds).padStart(14),
        fmtDuration(r.cumulativeSeconds).padStart(14),
        `${r.clearSeconds.toFixed(1)}s`.padStart(11),
        r.goldPerSecond.toFixed(1).padStart(10),
        String(r.totalLevels).padStart(7),
      ].join(' |'),
    );
  }

  lines.push('');
  if (wall === null) {
    lines.push(`reached stage ${MAX_STAGE} in ${fmtDuration(rows[rows.length - 1].cumulativeSeconds)}`);
  } else {
    lines.push(`WALL at stage ${wall} - ${stallReason}`);
    lines.push(diagnosis);
  }
  return lines.join('\n');
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/balance.ts');
if (invokedDirectly) {
  const out = report();
  console.log(out);
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, `${out}\n`, 'utf8');
    console.log(`\nwrote ${GOLDEN_PATH}`);
  }
}

