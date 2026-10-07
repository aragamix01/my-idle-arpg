/**
 * Save migration.
 *
 * This is what `contentVersion` was stamped into every save for. The server
 * recomputes progress from saves that may be weeks old, and a content change
 * that alters the *shape* of a save needs a step here or the new code reads
 * fields that are not there.
 *
 * Gold, stage and upgrades are never touched by any step.
 */

import { fromSave, toSave } from './big';
import {
  CONTENT_VERSION,
  DISSEMBLE_YIELD,
  getAffix,
  getUnique,
  rollUniqueValues,
  type CurrencyPurse,
  type RolledAffix,
} from './content';
import { armourSlotOf, rollStream, rollTablet } from './items';
import { ACCESSORY_SLOTS, ARMOUR_SLOT_KINDS, ITEM_SLOTS, type SaveState } from './types';

/** First version whose saves use rolled item instances. */
export const ITEMS_VERSION = 2;

/** First version where the field is `items` and bases carry implicits. */
export const IMPLICITS_VERSION = 3;

/** First version with a currency purse and per-item craft counters. */
export const CURRENCY_VERSION = 4;

/** First version where modifiers carry a layer instead of add/mul. */
export const LAYERS_VERSION = 5;

/** First version with a weapon slot, skills, and uniques that roll their values. */
export const WEAPONS_VERSION = 6;

/** First version where gold is a decimal string rather than a double. */
export const BIG_GOLD_VERSION = 7;

/** First version whose loadout array was seven long and slots were derived. Undone by 14. */
export const DERIVED_SLOTS_VERSION = 8;

/** First version with elements, resistance and penetration. */
export const ELEMENTS_VERSION = 9;

/** First version carrying Abyssal tablets. */
export const TABLETS_VERSION = 10;

/** First version where a tablet is an ItemInstance with rarity, an implicit and rows. */
export const TABLET_ITEMS_VERSION = 11;

/** First version with armour slots in place of the relic gear. */
export const ARMOUR_VERSION = 14;

/**
 * The relic bases Phase 8 deleted. Named here and nowhere else - the registry no longer
 * knows them, which is exactly why the migration has to.
 */
const RELIC_BASE_IDS = new Set([
  'whetstone',
  'glove',
  'purse',
  'sigil',
  'blade',
  'lens',
  'charm',
  'idol',
]);

export interface MigrationResult {
  state: SaveState;
  /** True when anything was reset, so the caller can tell the player. */
  migrated: boolean;
}

/** The pre-v3 field name, which no current type mentions. */
type LegacySave = SaveState & { artifactsOwned?: SaveState['items'] };

export function migrateSave(state: SaveState): MigrationResult {
  let migrated = false;
  const next: LegacySave = { ...state };

  // Steps run oldest-shape-first, and the field rename has to come before the
  // version-gated wipes rather than after. Running it last silently undid the
  // v1 wipe by copying the legacy field back over the emptied one.
  if (next.artifactsOwned !== undefined) {
    // v2 → v3 is a rename plus an added optional field, so it is lossless.
    // Deliberately non-destructive: v2 shipped a wipe, and wiping again one
    // release later would teach players that progress here is disposable.
    //
    // Items carried across keep their affixes and simply have no baseAffix.
    // That makes them marginally weaker than a fresh drop, which is the honest
    // outcome for an item that predates the mechanic - and every read path
    // already tolerates the field being absent.
    next.items = next.artifactsOwned;
    delete next.artifactsOwned;
    migrated = true;
  }

  if ((state.contentVersion ?? 0) < ITEMS_VERSION) {
    // v1 stored artifacts as bare string ids - a shape the item code cannot
    // read at all, so there is nothing to preserve.
    next.items = [];
    next.loadout = Array<string | null>(ITEM_SLOTS).fill(null);
    next.nextItemId = 1;
    migrated = true;
  }

  if (!Array.isArray(next.items)) {
    next.items = [];
    migrated = true;
  }

  if (next.currency === undefined || next.currency === null) {
    // v3 → v4 adds the purse and a per-item craft counter. Additive only;
    // nothing an existing save holds becomes unreadable.
    next.currency = {};
    migrated = true;
  }

  if (next.items.some((item) => typeof item.crafts !== 'number')) {
    // Seeding crafts from rerolls keeps each item's roll stream continuous:
    // starting everyone at zero would make the next gold reroll reproduce a
    // result the player has already seen.
    next.items = next.items.map((item) =>
      typeof item.crafts === 'number' ? item : { ...item, crafts: item.rerolls ?? 0 },
    );
    migrated = true;
  }

  if ((state.contentVersion ?? 0) < LAYERS_VERSION && next.items.length > 0) {
    // The one migration that is *allowed* to restat existing items.
    //
    // RolledAffix stores its magnitude rather than looking it up, precisely so a
    // retuned tier table cannot silently change an item someone already owns.
    // A change of formula is the exception that rule was written against: an old
    // Brutal stored 1.04 under `op: 'mul'`, and reading 1.04 as `increased` means
    // +104% damage. Leaving the numbers alone would be far more destructive than
    // re-resolving them.
    //
    // Identity survives - same affix id, same tier index, same item - so a player
    // keeps the item they earned and only its numbers move onto the new scale.
    // Affixes whose id no longer exists resolve to nothing, which itemEffects
    // already tolerates.
    const restat = (rolled: RolledAffix): RolledAffix => {
      const affix = getAffix(rolled.affixId);
      const tier = affix?.tiers[rolled.tier];
      return tier ? { ...rolled, value: tier.value } : rolled;
    };
    next.items = next.items.map((item) => ({
      ...item,
      affixes: item.affixes.map(restat),
      baseAffix: item.baseAffix ? restat(item.baseAffix) : undefined,
    }));
    migrated = true;
  }

  if (next.weapon === undefined) {
    // v5 -> v6 adds the weapon slot, and this step is deliberately POWER-NEUTRAL.
    //
    // Unarmed's bases are the exact BASE_STATS values every save derived before
    // skills existed, so a migrated character's stats do not move by a single point
    // on load. Nothing is rerolled, nothing is granted, and no gear is disturbed.
    //
    // What does change is what happens next: the gold upgrade tracks were retuned on
    // the assumption that a weapon carries two thirds of the ladder, so a migrated
    // player needs a weapon drop before they can push further. They can still farm
    // the stage they are on, and weapons take a healthy share of drops, so this
    // resolves itself within a few clears rather than becoming a wall.
    next.weapon = null;
    migrated = true;
  }

  if (next.items.some((item) => item.uniqueId && item.uniqueRolls === undefined)) {
    // v5 -> v6 gives every owned unique a roll inside its authored range.
    //
    // Rolled rather than pinned to the midpoint, even though itemEffects already
    // falls back to the midpoint. A stored roll is what Angel Flame rerolls and what
    // the panel reports quality against - leaving the field absent would give
    // existing owners a unique that reads as having no roll at all, and a currency
    // whose effect on it is invisible.
    //
    // Seeded from the item's own uid and craft count like every other roll, so the
    // client's optimistic migration and the server's authoritative one agree.
    next.items = next.items.map((item) => {
      if (!item.uniqueId || item.uniqueRolls !== undefined) return item;
      const unique = getUnique(item.uniqueId);
      if (!unique) return item;
      const rng = rollStream(state.seed, Number(item.uid), item.crafts);
      return { ...item, uniqueRolls: rollUniqueValues(unique, rng) };
    });
    migrated = true;
  }

  if (typeof (next.gold as unknown) === 'number' || next.lifetimeGold === undefined) {
    // v6 -> v7 moves gold from a double to a decimal string.
    //
    // Lossless in the direction that matters: whatever the double held is exactly what
    // the string holds, and from here the value can keep growing past 1.8e308 instead
    // of becoming Infinity somewhere around stage 6,100.
    //
    // lifetimeGold is seeded from the CURRENT balance rather than from zero. It is
    // wrong either way for an existing player - gold already spent is not recoverable -
    // but seeding it at zero would tell prestige that a player at stage 300 has never
    // earned anything, and understating a long-running account is the worse error.
    next.gold = toSave(fromSave(next.gold as unknown as string | number));
    if (next.lifetimeGold === undefined) next.lifetimeGold = next.gold;
    migrated = true;
  }

  if ((state.contentVersion ?? 0) < ARMOUR_VERSION && next.items.length > 0) {
    /*
      v13 -> v14: the relic gear is gone. Spoken decision - delete it outright, not
      convert it.

      Every relic is SALVAGED rather than vanished: it pays exactly what dissembling it
      would have, so the player is left holding the material, not an empty slot and a
      grievance. Uniques are not relics - each was re-homed onto an armour slot with its
      id and rolls intact, so they stay as they are and simply move to their new slot
      in the loadout rebuild below.
    */
    const salvaged: CurrencyPurse = { ...next.currency };
    next.items = next.items.filter((item) => {
      if (item.uniqueId || !RELIC_BASE_IDS.has(item.baseId)) return true;
      const yielded = DISSEMBLE_YIELD[item.rarity];
      salvaged[yielded] = (salvaged[yielded] ?? 0) + 1;
      return false;
    });
    next.currency = salvaged;
    migrated = true;
  }

  if (
    Array.isArray(next.loadout) &&
    (next.loadout.length !== ITEM_SLOTS ||
      next.loadout.some((uid, i) => {
        const item = uid ? next.items.find((it) => it.uid === uid) : undefined;
        return uid !== null && (!item || armourSlotOf(item) !== ARMOUR_SLOT_KINDS[i]);
      }))
  ) {
    /*
      Rebuilt by SLOT, not by position. The old loadout was positional - any piece in any
      of seven places - and the new one is one place per kind. Each worn piece goes to its
      own slot; the first claim on a slot wins and the rest go back to the bag, still
      owned. A uid pointing at a salvaged relic simply finds nothing.

      Also the guard for a save written by some other build: anything that is not a
      length-five array of correctly-slotted pieces is rebuilt the same way.
    */
    const rebuilt = Array<string | null>(ITEM_SLOTS).fill(null);
    for (const uid of next.loadout) {
      if (!uid) continue;
      const item = next.items.find((it) => it.uid === uid);
      const slot = item ? armourSlotOf(item) : undefined;
      const index = slot ? ARMOUR_SLOT_KINDS.indexOf(slot) : -1;
      if (index !== -1 && rebuilt[index] === null) rebuilt[index] = uid;
    }
    next.loadout = rebuilt;
    migrated = true;
  }

  if (!Array.isArray(next.tablets)) {
    // v9 -> v10 adds the tablet array. Purely additive, exactly like `weapon` in v6:
    // an existing save loads with no tablets, derives identical stats, and starts
    // collecting them the next time it clears a boss past the unlock floor. Nothing
    // is rerolled and no gear is touched.
    next.tablets = [];
    migrated = true;
  } else if (state.contentVersion < TABLET_ITEMS_VERSION) {
    /*
      v10 -> v11: a tablet became an ItemInstance.

      The old shape was `{ uid, tier, mods, crafts }` where `mods` were ids into a
      registry that no longer exists. There is no honest translation - the six bespoke
      mods had their own rewards baked in, and the new pool is pure danger paid for by
      an implicit that the old shape had no field for.

      So they are RE-ROLLED at the tier they were held at. A tablet is a consumable four
      commits old, not a chase item: regenerating one is a smaller loss than a
      translation nobody would ever exercise twice, and it cannot produce a tablet whose
      modifiers half-exist.
    */
    next.tablets = next.tablets.map((tablet, i) => {
      const legacy = tablet as unknown as { uid?: string; tier?: number };
      const uid = Number(legacy.uid ?? next.nextItemId + i);
      return rollTablet(next.seed, uid, legacy.tier ?? 1);
    });
    migrated = true;
  }

  if (!Array.isArray(next.accessories) || next.accessories.length !== ACCESSORY_SLOTS) {
    // v11 -> v12 adds the accessory array, and v14 a fourth position that only Traveller's
    // Harness opens. Purely additive, exactly like `weapon` in v6
    // and `tablets` in v10: an existing save loads with three empty slots, derives
    // identical stats, and fills them the first time the Abyss pays one. Nothing is
    // rerolled and no gear moves.
    //
    // Length-checked as well as presence-checked, so a save written by a build with a
    // different slot count is padded or truncated rather than left a size the equip
    // command would index past.
    const padded = Array<string | null>(ACCESSORY_SLOTS).fill(null);
    const held = Array.isArray(next.accessories) ? next.accessories : [];
    for (let i = 0; i < Math.min(ACCESSORY_SLOTS, held.length); i++) padded[i] = held[i] ?? null;
    next.accessories = padded;
    migrated = true;
  }

  // Defensive: a save written before nextItemId existed would otherwise produce
  // NaN uids, and every item would collide on the same roll seed.
  if (typeof next.nextItemId !== 'number' || !Number.isFinite(next.nextItemId)) {
    next.nextItemId = 1;
    migrated = true;
  }

  if (migrated) next.contentVersion = CONTENT_VERSION;
  return { state: next as SaveState, migrated };
}
