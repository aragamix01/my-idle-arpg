import { expect, test, type ConsoleMessage } from '@playwright/test';

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
  await expect(page.getByText(/cleared stage 1/)).toBeVisible();

  const claim = page.getByRole('button', { name: /idle gold/ });
  await expect(claim).toBeEnabled({ timeout: 15_000 });
  await expect(claim).not.toHaveText(/Claim 0 idle gold/);
});

test('progress survives a reload', async ({ page }) => {
  await page.goto('/');

  const upgrade = page.getByRole('button', { name: /^Damage/ });
  await expect(upgrade).toBeVisible();
  const before = await upgrade.textContent();

  // Stage 1 is beatable from a fresh save, so this pays for the first upgrade.
  await page.getByRole('button', { name: /Attempt stage/ }).click();
  await expect(page.getByText(/cleared stage 1/)).toBeVisible();

  await upgrade.click();
  await expect(upgrade).not.toHaveText(before ?? '');
  const after = await upgrade.textContent();

  // The real assertion: the server persisted it, not just the local store.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Damage/ })).toHaveText(after ?? '');
});
