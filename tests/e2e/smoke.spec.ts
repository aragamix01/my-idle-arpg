import { expect, test, type ConsoleMessage } from '@playwright/test';

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

  const claim = page.getByRole('button', { name: /idle gold/ });
  await expect(claim).toBeEnabled({ timeout: 15_000 });
  await expect(claim).not.toHaveText(/Claim 0 idle gold/);
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

  await panel.getByRole('button', { name: /^Inventory/ }).click();
  await expect(panel.getByText(/No items yet/)).toBeVisible();
  // Four slots, all empty on a fresh account.
  await expect(panel.getByText('empty', { exact: true })).toHaveCount(4);

  await expect(panel.getByText('undefined')).toHaveCount(0);
  await expect(panel.getByText('NaN')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
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
  await expect(page.getByRole('button', { name: /^Damage/ })).toHaveText(after ?? '');
});
