import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { WEAPON_BASES } from '../../src/sim';

/**
 * CSS that excludes every weapon tile, derived from the registry not written down.
 *
 * An attribute selector rather than Playwright's `hasNotText`, because a grid tile
 * renders only a sprite - the item's name is in its `title`, so a text filter matched
 * nothing at all and quietly selected the first tile regardless. That made the tests
 * using it pass or fail on whether the newest drop happened to be a weapon.
 *
 * Derived, because a hand-written /Axe|Wand/ went stale the same day two more weapons
 * were added.
 */
const NOT_A_WEAPON = WEAPON_BASES.map((b) => `:not([title*="${b.name}"])`).join('');

/**
 * Attempts now play out a replay before the command is sent, so anything
 * asserting on the result has to outlast it. Stage 1 is ~49 simulated seconds
 * at 6x, plus the round trip.
 */
const REPLAY_TIMEOUT = 20_000;

/**
 * The blind spot the unit suite structurally cannot see: the sim can be
 * perfect and the app still a white screen. Everything here is about the app
 * booting and the round trip closing, not about game rules.
 */

/**
 * Clear the welcome-back receipt, which covers the screen after any reload.
 *
 * Idle gold is credited on arrival now and reported in a modal, so every test that
 * reloads a save with a cleared stage meets one - and its backdrop intercepts pointer
 * events until dismissed. That is the intended behaviour for a player; for a test it
 * is a door that has to be opened before anything else can be clicked.
 *
 * Tolerates absence: a fresh save has no best stage, so no idle income, so no receipt.
 */
async function dismissReceipt(page: Page) {
  try {
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 4000 });
  } catch {
    // Nothing to dismiss.
  }
}

/** Next's dev overlay and asset 404s are noisy; only real page errors matter. */
function collectErrors(messages: ConsoleMessage[]): string[] {
  return messages
    .filter((m) => m.type() === 'error')
    .map((m) => m.text())
    .filter((text) => !text.includes('favicon'));
}

test('boots, renders, and closes the command round trip', async ({ page }) => {
  const consoleMessages: ConsoleMessage[] = [];
  const pageErrors: Error[] = [];
  page.on('console', (m) => consoleMessages.push(m));
  page.on('pageerror', (e) => pageErrors.push(e));

  await page.goto('/');

  // The HUD only renders once /api/state has answered, so this covers session
  // creation and the first save write as well.
  await expect(page.getByRole('button', { name: /Attempt stage/ })).toBeVisible();

  const canvas = page.locator('[data-testid="game-canvas"] canvas');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }));
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);

  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(collectErrors(consoleMessages), 'console errors').toEqual([]);
});

test('the render loop actually advances', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Attempt stage/ })).toBeVisible();

  // Pixi's Application.init is async and the dynamic import resolves after the
  // HUD does, so the handle appears strictly later than the buttons.
  await page.waitForFunction(() => '__stageVisual' in globalThis, undefined, { timeout: 15_000 });

  // A mounted canvas proves nothing - a dead ticker looks identical from the
  // DOM. Sample the cosmetic layer twice and require movement.
  const moved = await page.evaluate(async () => {
    const visual = (globalThis as { __stageVisual?: { player: { x: number; y: number } } })
      .__stageVisual;
    if (!visual) return 'no visual handle';
    const first = { ...visual.player };
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = { ...visual.player };
    return first.x !== second.x || first.y !== second.y ? 'moved' : 'static';
  });

  expect(moved).toBe('moved');
});

test('draws atlas sprites rather than placeholders', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__renderStats' in globalThis, undefined, { timeout: 15_000 });

  // A canvas of fallback circles is indistinguishable from a canvas of sprites
  // through the DOM, so the renderer counts which it drew.
  const stats = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return (
      globalThis as {
        __renderStats?: { atlasLoaded: boolean; sprites: number; placeholders: number };
      }
    ).__renderStats;
  });

  expect(stats?.atlasLoaded, 'atlas failed to load').toBe(true);
  expect(stats?.sprites ?? 0, 'no sprites drawn').toBeGreaterThan(0);
  expect(stats?.placeholders ?? -1, 'some enemies fell back to placeholders').toBe(0);
});

test('the sword swings', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__stageVisual' in globalThis, undefined, { timeout: 15_000 });

  // Kenney Tiny Dungeon has no animation frames, so the swing is procedural:
  // a static sword sprite swept around the player. If the cadence stalls the
  // sprite simply stops appearing, which nothing else would catch.
  const observed = await page.evaluate(async () => {
    type Visual = { swing: { active: boolean; progress: number }; swingAngle(): number };
    const visual = (globalThis as { __stageVisual?: Visual }).__stageVisual!;

    const angles = new Set<number>();
    let sawActive = false;

    for (let i = 0; i < 60; i++) {
      if (visual.swing.active) {
        sawActive = true;
        angles.add(Math.round(visual.swingAngle() * 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { sawActive, distinctAngles: angles.size };
  });

  expect(observed.sawActive, 'swing never became active').toBe(true);
  // A frozen sweep would report one angle repeatedly.
  expect(observed.distinctAngles, 'swing angle never changed').toBeGreaterThan(3);
});

test('an attempt plays through wave, boss, then commits', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__stageVisual' in globalThis, undefined, { timeout: 15_000 });

  await page.getByRole('button', { name: /Attempt stage/ }).click();

  // The command must not have been sent yet - the whole point of the replay is
  // that gold and stage move when the fight resolves, not when it starts.
  await expect(page.getByRole('button', { name: /Fighting stage/ })).toBeVisible();

  const trace = await page.evaluate(async () => {
    type Visual = {
      attempt: { active: boolean; phase: string; elapsed: number; playerHp: number };
      boss: { alive: boolean };
    };
    const visual = (globalThis as { __stageVisual?: Visual }).__stageVisual!;

    const phases = new Set<string>();
    let sawBoss = false;
    let minPlayerHp = 1;
    let maxElapsed = 0;

    for (let i = 0; i < 200; i++) {
      if (visual.attempt.active) {
        phases.add(visual.attempt.phase);
        if (visual.boss.alive) sawBoss = true;
        minPlayerHp = Math.min(minPlayerHp, visual.attempt.playerHp);
        maxElapsed = Math.max(maxElapsed, visual.attempt.elapsed);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { phases: [...phases], sawBoss, minPlayerHp, maxElapsed };
  });

  expect(trace.phases, 'both phases should be reached').toContain('trash');
  expect(trace.phases).toContain('boss');
  expect(trace.sawBoss, 'boss never spawned').toBe(true);
  // Stage 1 costs real health, so a bar pinned at full would mean the damage
  // split is not being applied.
  expect(trace.minPlayerHp).toBeLessThan(1);
  // Elapsed is in simulated seconds, so it should reach tens, not the handful
  // of real seconds the replay took.
  expect(trace.maxElapsed).toBeGreaterThan(10);

  await expect(page.getByText(/cleared stage 1/)).toBeVisible({ timeout: REPLAY_TIMEOUT });
  await expect(page.getByRole('button', { name: /Attempt stage 2/ })).toBeVisible();
});

test('every upgrade track is rendered', async ({ page }) => {
  await page.goto('/');

  // Guards the loop over UPGRADE_KEYS. A track added to curves.ts with no
  // EFFECT_NOUNS entry would render "undefined" rather than fail loudly.
  for (const label of [
    'Damage',
    'Attack Speed',
    'Area',
    'Critical',
    'Health',
    'Toughness',
    'Greed',
  ]) {
    await expect(page.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }

  await expect(page.getByText('undefined')).toHaveCount(0);
  await expect(page.getByText('NaN')).toHaveCount(0);
});

test('idle gold accrues even when the browser clock is wrong', async ({ page }) => {
  // lastSeenAt is stamped by the server. Measuring against an unadjusted
  // Date.now() made elapsed time negative on any browser running behind, which
  // clamped to zero and pinned idle gold at 0.
  await page.addInitScript(() => {
    const skewMs = 10 * 60 * 1000;
    const RealDate = Date;
    const shifted = class extends RealDate {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        if (args.length === 0) super(RealDate.now() - skewMs);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        else super(...(args as [any]));
      }
      static now() {
        return RealDate.now() - skewMs;
      }
    };
    globalThis.Date = shifted as DateConstructor;
  });

  await page.goto('/');

  // Farm income comes from the best cleared stage, so there is nothing to
  // accrue until stage 1 is beaten.
  await page.getByRole('button', { name: /Attempt stage/ }).click();
  await expect(page.getByText(/cleared stage 1/)).toBeVisible({ timeout: REPLAY_TIMEOUT });

  // Idle gold is credited on arrival now and reported on the next visit, so the
  // assertion moved from a Claim button to the receipt. Same property either way:
  // the accrual is measured against the SERVER's clock, and a browser running ten
  // minutes behind used to make elapsed time negative and pin income at zero.
  await page.reload();

  const receipt = page.getByRole('dialog', { name: 'Welcome back' });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).not.toContainText('+0 ');
  await expect(receipt).toContainText(/You were away/);

  await dismissReceipt(page);
  // And it is a receipt, not a prompt: the gold is already banked, so dismissing
  // leaves nothing owed and the modal does not come back.
  await expect(receipt).toBeHidden();
});

test('the buy multiplier applies to every track', async ({ page }) => {
  await page.goto('/');

  const damage = page.getByRole('button', { name: /^Damage/ });
  const health = page.getByRole('button', { name: /^Health/ });
  await expect(damage).toBeVisible();

  // One selector drives all seven buttons, so both labels must respond.
  await page.getByLabel('Buy').selectOption('10');
  await expect(damage).toHaveText(/\+10/);
  await expect(health).toHaveText(/\+10/);

  await page.getByLabel('Buy').selectOption('1');
  await expect(damage).not.toHaveText(/\+10/);

  await page.getByRole('button', { name: /Attempt stage/ }).click();
  await expect(page.getByText(/cleared stage 1/)).toBeVisible({ timeout: REPLAY_TIMEOUT });

  // Max buys as many levels as the gold covers, which after one clear is
  // several - the point being it is more than the single level 1x would buy.
  await page.getByLabel('Buy').selectOption('max');
  await damage.click();
  await expect(page.getByText(/damage \+\d+ →/)).toBeVisible();

  const label = await damage.textContent();
  const level = Number(/Lv (\d+)/.exec(label ?? '')?.[1] ?? 0);
  expect(level).toBeGreaterThan(1);
});

test('fits a phone without scrolling, and every control stays reachable', async ({ page }) => {
  // The rest of this file runs at Playwright's 1280x720, which is exactly why the
  // mobile layout could rot unnoticed: the reported failure was the action row
  // hidden behind Safari's chrome and sprites crawling through the upgrade text,
  // and a desktop viewport shows neither.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Attempt stage/ })).toBeVisible();

  // The shell is three fixed rows summing to the viewport. If it scrolls, something
  // has been pushed off the bottom - which is the whole bug.
  const overflow = await page.evaluate(
    () => document.body.scrollHeight - window.innerHeight,
  );
  expect(overflow, 'the page scrolls vertically on a phone').toBeLessThanOrEqual(1);

  // Reachable means inside the viewport, not merely present in the DOM.
  for (const name of [/Attempt stage/, /^Upgrades$/]) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.y + box!.height, `${name} sits below the fold`).toBeLessThanOrEqual(812);
    // Apple's minimum comfortable target. These were text-sized before.
    expect(box!.height, `${name} is too small to tap`).toBeGreaterThanOrEqual(40);
  }

  // The tracks live in a pull-up sheet on a phone rather than eating the screen.
  await expect(page.getByRole('dialog', { name: 'Upgrades' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Upgrades$/ }).click();

  const sheet = page.getByRole('dialog', { name: 'Upgrades' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Buy')).toBeVisible();

  const damage = sheet.getByRole('button', { name: /^Damage/ });
  const box = await damage.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(812);

  // And it closes, or the sheet is a trap on a device with no Escape key.
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
});

test('the character panel shows every stat and the empty inventory', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });
  await expect(panel).toBeVisible();

  // Every label in STAT_LABELS must appear. A stat added to STAT_KEYS without
  // an entry is a type error, but one added to the panel's ordering and not the
  // label map would render blank - this catches that.
  for (const label of [
    'Damage',
    'Attack Speed',
    'Area',
    'Crit Chance',
    'Crit Damage',
    'Max HP',
    'Toughness',
    'Gold Find',
  ]) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
  }

  // Derived figures are the reason the panel exists - raw stats alone do not
  // tell a player whether they will survive.
  for (const label of ['Effective HP', 'DPS (single)', 'DPS (wave)', 'Kills / sec']) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
  }

  // Expanding a stat has to show what produced it. The components come from the sim
  // and the row from the panel, so this is the one assertion that proves the two are
  // wired together at all - a breakdown that renders empty is invisible in a unit test.
  await panel.getByRole('button', { name: /Damage/ }).first().click();
  await expect(panel.getByText('base', { exact: true })).toBeVisible();

  await panel.getByRole('button', { name: /^Inventory/ }).click();
  await expect(panel.getByText(/No items yet/)).toBeVisible();
  // Four slots, all empty on a fresh account.
  await expect(panel.getByText('empty', { exact: true })).toHaveCount(4);

  await expect(panel.getByText('undefined')).toHaveCount(0);
  await expect(panel.getByText('NaN')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('the inventory grid selects, filters and sorts', async ({ page }) => {
  await page.goto('/');

  // Two clears, which is what a fresh save can manage before it needs
  // upgrades. Even at the minimum of one drop each that is enough items for
  // the grid to be a grid.
  for (const stage of [1, 2]) {
    await page.getByRole('button', { name: /Attempt stage/ }).click();
    await expect(page.getByText(new RegExp(`cleared stage ${stage}`))).toBeVisible({
      timeout: REPLAY_TIMEOUT,
    });
  }

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });
  await panel.getByRole('button', { name: /^Inventory/ }).click();

  const tiles = panel.getByRole('list', { name: 'Item grid' }).getByRole('button');
  const total = await tiles.count();
  expect(total).toBeGreaterThanOrEqual(2);

  // Nothing is selected until the player picks something - the detail pane is
  // the only place affixes are readable, so this is the core interaction.
  await expect(panel.getByText(/Select an item to inspect/)).toBeVisible();
  // Gear, not the newest tile: a weapon equips to its own slot and would never move
  // the "Equipped (n/4)" counter this asserts on.
  await panel.locator(`[aria-label="Item grid"] button${NOT_A_WEAPON}`).first().click();
  await expect(panel.getByText(/Select an item to inspect/)).toHaveCount(0);

  // Equipping from the detail pane must reach the sim, not just the pane.
  await expect(panel.getByText('Equipped (0/4)')).toBeVisible();
  await panel.getByRole('button', { name: 'Equip', exact: true }).click();
  await expect(panel.getByText('Equipped (1/4)')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Unequip', exact: true })).toBeVisible();

  // Rarity filters must partition the inventory exactly: every item shown by
  // one chip and no other. An earlier version asserted a Unique filter would
  // empty the grid, which was a guess about drop rates rather than a rule -
  // and one run duly rolled a unique inside two clears.
  let partitioned = 0;
  for (const rarity of ['Common', 'Magic', 'Rare', 'Unique']) {
    const chip = panel.getByRole('button', { name: rarity, exact: true });
    await chip.click();
    partitioned += await tiles.count();
    await chip.click();
  }
  expect(partitioned).toBe(total);
  await expect(tiles).toHaveCount(total);

  // Sorting reorders rather than dropping anything.
  await panel.getByLabel('Sort').selectOption('rarity');
  await expect(tiles).toHaveCount(total);

  await expect(panel.getByText('undefined')).toHaveCount(0);
  await expect(panel.getByText('NaN')).toHaveCount(0);
});

test('a weapon says what its skill costs to use', async ({ page }) => {
  await page.goto('/');

  // Clear until a weapon drops rather than a fixed number of times. Weapons take a
  // share of drops, not a reserved slot, so "clear twice" is a coin flip - the same
  // assumption that made two other tests pass or fail on the newest tile's base.
  const baseId = await page.evaluate(async (weaponIds: string[]) => {
    const post = (body: unknown) =>
      fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    for (let i = 0; i < 40; i++) {
      const result = await post({ type: 'attemptStage' });
      const items: { baseId: string }[] = result?.state?.items ?? [];
      const weapon = items.find((item) => weaponIds.includes(item.baseId));
      if (weapon) return weapon.baseId;
      for (const key of ['damage', 'health', 'attackSpeed', 'toughness']) {
        await post({ type: 'buyUpgrade', key, count: 'max' });
      }
    }
    return null;
  }, WEAPON_BASES.map((b) => b.id));
  expect(baseId, 'no weapon dropped in 40 clears').not.toBeNull();
  await page.reload();
  await dismissReceipt(page);

  const baseName = WEAPON_BASES.find((b) => b.id === baseId)!.name;

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });
  await panel.getByRole('button', { name: /^Inventory/ }).click();
  await panel.locator(`[aria-label="Item grid"] button[title*="${baseName}"]`).first().click();

  // The cost, and the regen it demands. Neither alone is actionable: deriveStats
  // caps attack speed at regen/cost silently, so a bare "3.0" leaves the cap
  // untraceable and a bare regen figure cannot say whether it is enough.
  const detail = panel.getByRole('complementary');
  await expect(detail).toContainText(/(Stamina|Mana) \d+\.\d\/use/);
  await expect(detail).toContainText(/needs \d+\.\d\d\/s regen/);
  // The skill's own bases, which are the half of a weapon's worth that is not in
  // its affix list.
  await expect(detail).toContainText(/base damage · \d+\.\d\d\/s · \d+ targets?/);
});

test('the craft modal explains what it refuses, and applies what it allows', async ({ page }) => {
  await page.goto('/');

  // Seed a stash and a mixed inventory through the API rather than by playing:
  // fragments accumulate slowly by design, and this test is about the modal.
  await page.evaluate(async () => {
    for (let i = 0; i < 6; i++) {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'attemptStage' }),
      });
      for (const key of ['damage', 'health', 'attackSpeed', 'toughness']) {
        await fetch('/api/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'buyUpgrade', key, count: 'max' }),
        });
      }
    }
  });
  await page.reload();
  await dismissReceipt(page);

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });

  // The stash lists every currency, including ones held at zero - an empty
  // slot is how a player learns what exists.
  await panel.getByRole('button', { name: 'Currency', exact: true }).click();
  await expect(panel.getByRole('list', { name: 'Currency' }).getByText('Magic Ore')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Spirits' }).getByText('Dune Spirit')).toBeVisible();

  await panel.getByRole('button', { name: /^Inventory/ }).click();
  const tiles = panel.getByRole('list', { name: 'Item grid' }).getByRole('button');
  await tiles.first().click();

  await panel.getByRole('button', { name: 'Craft…' }).click();
  const craft = page.getByRole('dialog', { name: 'Craft' });
  await expect(craft).toBeVisible();

  // Gold reroll is one option among several, not the only way to change an item.
  await expect(craft.getByText('Gold Reroll')).toBeVisible();

  await craft.getByRole('button', { name: /Close craft/ }).click();
  await expect(craft).toBeHidden();

  await expect(panel.getByText('undefined')).toHaveCount(0);
  await expect(panel.getByText('NaN')).toHaveCount(0);
});

test('the craft modal shows the mods and stays open across rolls', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(async () => {
    const post = (body: unknown) =>
      fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Climb first, spending everything on upgrades so item levels rise.
    for (let i = 0; i < 25; i++) {
      await post({ type: 'attemptStage' });
      for (const key of ['damage', 'health', 'attackSpeed', 'toughness', 'greed']) {
        await post({ type: 'buyUpgrade', key, count: 'max' });
      }
    }
    // Then bank. Reroll cost scales with item level, and a climb that spends
    // every coin on upgrades leaves nothing to craft with - which is how this
    // test first failed, on a disabled Gold Reroll.
    for (let i = 0; i < 10; i++) await post({ type: 'attemptStage' });
  });
  await page.reload();
  await dismissReceipt(page);

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });
  await panel.getByRole('button', { name: /^Inventory/ }).click();

  const tiles = panel.getByRole('list', { name: 'Item grid' }).getByRole('button');
  await tiles.first().click();
  await panel.getByRole('button', { name: 'Craft…' }).click();

  const craft = page.getByRole('dialog', { name: 'Craft' });
  await expect(craft).toBeVisible();

  // The modifiers are visible in the window that changes them - a prefix or
  // suffix badge beside every rolled line.
  const badges = craft.locator('li span').filter({ hasText: /^[PS]$/ });
  await expect(badges.first()).toBeVisible();

  // The rolled affixes live in the last list in the header; the implicit has
  // its own above it, separated by a rule.
  const rolled = craft.locator('header ul').last();
  const implicit = craft.locator('header ul').first();

  const rolledBefore = await rolled.textContent();
  const implicitBefore = await implicit.textContent();

  // Roll, and the modal must survive it: crafting is roll-look-roll, and
  // closing on each application forced a reopen to continue the same loop.
  const reroll = craft.getByRole('button', { name: /^Gold Reroll/ });
  await expect(reroll).toBeEnabled();
  await reroll.click();

  await expect(craft).toBeVisible();
  await expect.poll(async () => rolled.textContent()).not.toBe(rolledBefore);
  // The implicit is the guaranteed half and no roll may touch it.
  expect(await implicit.textContent()).toBe(implicitBefore);

  // And again, without touching anything else.
  await reroll.click();
  await expect(craft).toBeVisible();

  await craft.getByRole('button', { name: /Close craft/ }).click();
  await expect(craft).toBeHidden();
});

test('dissembling a common yields a fragment without a confirmation', async ({ page }) => {
  await page.goto('/');

  // Enough clears that a common is a certainty. A single clear drops one to
  // three items at 55% common each, so one run in ten has none at all - an
  // earlier version filtered to Common after one clear and duly found an empty
  // grid in the full suite.
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'attemptStage' }),
      });
      for (const key of ['damage', 'health', 'attackSpeed', 'toughness']) {
        await fetch('/api/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'buyUpgrade', key, count: 'max' }),
        });
      }
    }
  });
  await page.reload();
  await dismissReceipt(page);

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });
  await panel.getByRole('button', { name: /^Inventory/ }).click();

  // Filter to commons rather than trusting the first tile. Rarity is rolled,
  // and an earlier version of this test passed alone and failed in the suite
  // because that run happened to open on a rare - which asks to confirm.
  await panel.getByRole('button', { name: 'Common', exact: true }).click();
  const tiles = panel.getByRole('list', { name: 'Item grid' }).getByRole('button');
  const before = await tiles.count();
  expect(before).toBeGreaterThan(0);

  await tiles.first().click();
  // Exact: the filter bar's sweep button is also called Dissemble, with a count.
  await panel.getByRole('button', { name: 'Dissemble', exact: true }).click();

  // Straight through: confirming every common would train the reflex that
  // makes the dialog useless on the one item where it matters.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(tiles).toHaveCount(before - 1);

  // The fragment it melted down to is in the stash. Asserted on the count
  // rather than the combine button's label, which switches from "N/10" to
  // "Combine (N)" once ten have accumulated.
  await panel.getByRole('button', { name: 'Currency', exact: true }).click();
  const shards = panel.getByRole('list', { name: 'Fragments' });
  await expect(shards.getByText('Magic Ore Shard')).toBeVisible();
  await expect(shards.getByText(/^x[1-9]\d*$/).first()).toBeVisible();
});

test('fragments combine into ore, and the ore upgrades a common', async ({ page }) => {
  await page.goto('/');

  // Clear UNTIL ten Magic Ore Shards have accumulated, rather than a fixed number
  // of attempts. Fragments come from stage bosses, so they only arrive on a clear -
  // and a fixed attempt count silently assumes every attempt succeeds. It stopped
  // being true when the upgrade tracks were slowed for weapon scaling: the same 25
  // attempts now include failures, the shards fell short, and the test timed out
  // waiting for a Combine button that was never going to appear.
  await page.evaluate(async () => {
    const post = (body: unknown) =>
      fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    for (let i = 0; i < 120; i++) {
      const result = await post({ type: 'attemptStage' });
      for (const key of ['damage', 'health', 'attackSpeed', 'toughness']) {
        await post({ type: 'buyUpgrade', key, count: 'max' });
      }
      if ((result?.state?.currency?.['magic-ore-shard'] ?? 0) >= 10) return;
    }
  });
  await page.reload();
  await dismissReceipt(page);

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });
  await panel.getByRole('button', { name: 'Currency', exact: true }).click();

  const stash = panel.getByRole('list', { name: 'Currency' });
  const fragments = panel.getByRole('list', { name: 'Fragments' });

  await expect(stash.getByText('Magic Ore')).toBeVisible();
  await expect(stash.getByText('x0')).not.toHaveCount(0);

  // Combine: ten shards become one ore.
  await fragments.getByRole('button', { name: /^Combine/ }).first().click();
  await expect(stash.getByText('Magic Ore').locator('..')).toContainText('x1');

  // Arm it, which switches to the inventory, then click a common.
  await stash.getByRole('button', { name: /Magic Ore/ }).click();
  await expect(panel.getByText(/Magic Ore armed/)).toBeVisible();

  await panel.getByRole('button', { name: 'Common', exact: true }).click();
  const tiles = panel.getByRole('list', { name: 'Item grid' }).getByRole('button');
  const commonsBefore = await tiles.count();
  expect(commonsBefore).toBeGreaterThan(0);

  await tiles.first().click();

  // One fewer common, because it became a magic. The arming clears itself, so
  // the next click inspects rather than crafting again.
  await expect(tiles).toHaveCount(commonsBefore - 1);
  // Word-bounded, because the weapon slot renders "Unarmed" when empty and a bare
  // /armed/ matches the middle of it. The banner this is asserting the absence of
  // reads "Magic Ore armed".
  await expect(panel.getByText(/\barmed\b/)).toHaveCount(0);
  await expect(page.getByText(/used Magic Ore/)).toBeVisible();
});

test('a dungeon spends a key and plays as a boss-only duel', async ({ page }) => {
  await page.goto('/');

  const dungeon = page.getByRole('button', { name: /^Dungeon/ });
  // Nothing to spend yet: keys drop from stage bosses.
  await expect(dungeon).toBeDisabled();

  // Clear *until* a key drops rather than a fixed number of times. Keys are a
  // 20% roll, so twenty clears still leaves one run in eighty with none - which
  // is exactly how this test failed once.
  const keysFound = await page.evaluate(async () => {
    const post = (body: unknown) =>
      fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    for (let i = 0; i < 60; i++) {
      const result = await post({ type: 'attemptStage' });
      const held = result?.state?.currency?.['dungeon-key'] ?? 0;
      if (held > 0) return held;
      for (const key of ['damage', 'health', 'attackSpeed', 'toughness']) {
        await post({ type: 'buyUpgrade', key, count: 'max' });
      }
    }
    return 0;
  });
  expect(keysFound).toBeGreaterThan(0);
  await page.reload();
  await dismissReceipt(page);

  await expect(dungeon).toBeEnabled();
  // Read from the accessible name, not from the rendered text. The button now also
  // carries the dungeon's elemental affinity as two letters, so "the digits at the
  // end" stopped being the key count the moment that shipped - and it failed here as
  // a mystery rather than as the display change it was. The label states the count in
  // words and is what a screen reader gets, so it is the more honest source anyway.
  const label = (await dungeon.getAttribute('aria-label')) ?? '';
  const keysBefore = Number(label.match(/(\d+)\s+keys?/)?.[1] ?? 0);
  expect(keysBefore).toBeGreaterThan(0);

  await dungeon.click();

  // The banner says DUNGEON, and there is no WAVE phase to pass through.
  const banner = () =>
    page.evaluate(() => {
      const visual = (globalThis as unknown as { __stageVisual?: { attempt: Record<string, unknown> } })
        .__stageVisual;
      return visual ? visual.attempt : null;
    });
  await expect
    .poll(async () => (await banner())?.kind, { timeout: REPLAY_TIMEOUT })
    .toBe('dungeon');
  await expect.poll(async () => (await banner())?.trashSeconds).toBe(0);

  // Resolved: the key is spent whichever way it went.
  await expect(page.getByText(/cleared dungeon|dungeon failed/)).toBeVisible({
    timeout: REPLAY_TIMEOUT,
  });
  await expect
    .poll(async () =>
      Number(((await dungeon.getAttribute('aria-label')) ?? '').match(/(\d+)\s+keys?/)?.[1] ?? -1),
    )
    .toBe(keysBefore - 1);
});

/**
 * The Abyss surface, at the only state a browser test can honestly reach.
 *
 * It cannot run one. Reaching floor 80 needs gear, not just upgrades - measured: a
 * character buying max upgrades on every track and clearing three thousand stages
 * stalls at stage 23, because the ladder outgrows what gold alone buys. Climbing there
 * through the API would mean reimplementing the balance harness's equip logic inside a
 * page.evaluate and several hundred round trips for it.
 *
 * So the split is the same one the drop animation ended up with: node covers the replay
 * and the command, where the sim can be driven directly, and this covers the thing node
 * cannot see - that the control exists, opens, and explains itself.
 */
test('the Abyss says why it is shut', async ({ page }) => {
  await page.goto('/');

  const abyss = page.getByRole('button', { name: /^The Abyss/ });
  // The gate is in the accessible name, so a player who cannot see the sheet still
  // learns the floor. A disabled button with no label would explain nothing.
  await expect(abyss).toHaveAccessibleName(/opens at floor 80/);

  await abyss.click();
  const sheet = page.getByRole('dialog', { name: 'The Abyss' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(/The Abyss opens at floor 80/);
  // And where the first one comes from, which is the other half of a shut door.
  await expect(sheet).toContainText(/No tablets/);
  await expect(sheet.getByRole('button', { name: 'Descend' })).toHaveCount(0);
});

test('multi-select dissembles exactly what was picked', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(async () => {
    const post = (body: unknown) =>
      fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (let i = 0; i < 20; i++) {
      await post({ type: 'attemptStage' });
      for (const key of ['damage', 'health', 'attackSpeed', 'toughness']) {
        await post({ type: 'buyUpgrade', key, count: 'max' });
      }
    }
  });
  await page.reload();
  await dismissReceipt(page);

  await page.getByRole('button', { name: /^Character/ }).click();
  const panel = page.getByRole('dialog', { name: 'Character' });
  await panel.getByRole('button', { name: /^Inventory/ }).click();

  const tiles = panel.getByRole('list', { name: 'Item grid' }).getByRole('button');
  const total = await tiles.count();
  expect(total).toBeGreaterThan(4);

  // Equip one, so select mode has something it must refuse to offer.
  //
  // Explicitly a piece of GEAR, not just the first tile. A fifth of drops are
  // weapons now and a weapon goes to its own slot, so "Equipped (1/4)" would never
  // appear - and since the newest item is a weapon only sometimes, taking the first
  // tile made this pass or fail depending on the account seed.
  const gear = panel.locator(`[aria-label="Item grid"] button${NOT_A_WEAPON}`).first();
  const gearTitle = await gear.getAttribute('title');
  await gear.click();
  await panel.getByRole('button', { name: 'Equip', exact: true }).click();
  await expect(panel.getByText('Equipped (1/4)')).toBeVisible();

  // No destructive bulk button exists until the player opts into select mode.
  await expect(panel.getByRole('button', { name: /^Dissemble \d+$/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(panel.getByText('0 selected')).toBeVisible();

  // Exactly one tile is unselectable, and it is the one just equipped.
  //
  // Asserted as a count rather than by position: the item equipped above is the
  // first piece of GEAR, and that is only tile zero when tile zero is not a weapon.
  const pickable = tiles.and(panel.locator('button:not([disabled])'));
  await expect(pickable).toHaveCount(total - 1);
  expect(gearTitle, 'equipped a tile with no title').toBeTruthy();

  // Pick three, then unpick one - the toggle has to work both ways. Selectable tiles
  // only, so the equipped one is never among them whatever index it landed on.
  await pickable.nth(0).click();
  await pickable.nth(1).click();
  await pickable.nth(2).click();
  await expect(panel.getByText('3 selected')).toBeVisible();
  await pickable.nth(2).click();
  await expect(panel.getByText('2 selected')).toBeVisible();

  const sweep = panel.getByRole('button', { name: /^Dissemble \d+$/ });
  await expect(sweep).toHaveText('Dissemble 2');

  // Cancelling must destroy nothing and keep the selection.
  await sweep.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(tiles).toHaveCount(total);
  await expect(panel.getByText('2 selected')).toBeVisible();

  await sweep.click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByText('Dissemble 2 items?')).toBeVisible();
  await confirm.getByRole('button', { name: /^Dissemble \d+$/ }).click();

  // Exactly the two picked, and nothing else.
  await expect(tiles).toHaveCount(total - 2);
  await expect(page.getByText(/dissembled 2 items/)).toBeVisible();
  // Selection cleared, mode kept: clearing an inventory takes more than one batch.
  await expect(panel.getByText('0 selected')).toBeVisible();

  // Select shown picks everything visible except what is worn.
  await panel.getByRole('button', { name: 'Select shown' }).click();
  await expect(panel.getByText(`${total - 3} selected`)).toBeVisible();

  await panel.getByRole('button', { name: 'Clear' }).click();
  await expect(panel.getByText('0 selected')).toBeVisible();

  // Leaving select mode takes the toolbar with it.
  await panel.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(panel.getByText(/selected/)).toHaveCount(0);
});

test('progress survives a reload', async ({ page }) => {
  await page.goto('/');

  const upgrade = page.getByRole('button', { name: /^Damage/ });
  await expect(upgrade).toBeVisible();
  const before = await upgrade.textContent();

  // Stage 1 is beatable from a fresh save, so this pays for the first upgrade.
  await page.getByRole('button', { name: /Attempt stage/ }).click();
  await expect(page.getByText(/cleared stage 1/)).toBeVisible({ timeout: REPLAY_TIMEOUT });

  await upgrade.click();
  await expect(upgrade).not.toHaveText(before ?? '');
  const after = await upgrade.textContent();

  // The real assertion: the server persisted it, not just the local store.
  await page.reload();
  await dismissReceipt(page);
  await expect(page.getByRole('button', { name: /^Damage/ })).toHaveText(after ?? '');
});
