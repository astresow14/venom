import { expect, test, type Page } from '@playwright/test';

/**
 * Adaptive slime quality on the phone map, measured on the dense fixture.
 *
 * Headless Chromium rasterizes with SwiftShader — a stand-in for the older
 * phones this exists for. `slimeTier=medium` pins a rich tier (device
 * detection would otherwise hand a software rasterizer the sparse tier)
 * whose per-frame cost still swamps the frame budget, so the frame-time
 * controller must shrink the GL surface instead of letting the map stutter.
 * Medium proves the same shedding contract as full while skipping the far
 * larger first-compile bill SwiftShader charges for the biggest program —
 * the tiers differ only in uniform capacity, and brain-slime-tiers still
 * compiles and rasterizes every tier including full.
 */

type Telemetry = {
  pinned: boolean;
  scale: number;
  initialScale: number;
  minScale: number;
  maxScale: number;
  frames: number;
  changes: number;
  bufferWidth: number;
  bufferHeight: number;
  /** First real drawing-buffer width, captured by the renderer pre-shed. */
  initialBufferWidth: number;
  /** Buffer width as a fraction of the full map surface (mapSize × dpr). */
  bufferFraction: number;
  paused: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __venomSlime: Telemetry | undefined;
}

async function openDenseBrain(page: Page) {
  await page.goto('/?venomUiTest=true&brainFixture=dense&slimeTier=medium');
  const brainTab = page.getByRole('tab', { name: 'Open Brain workspace' });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('knowledge-map')).toHaveAttribute(
    'aria-label',
    /Living ontology with 5 selectable/,
  );
}

test('shrinks the goo surface under load instead of stuttering', async ({
  page,
}) => {
  await openDenseBrain(page);

  // The GL layer is up once frames are being counted (the surface starts
  // 1x1 on web and only counts once real pixels are shaded).
  await page.waitForFunction(
    () => (globalThis.__venomSlime?.frames ?? 0) > 0,
    undefined,
    { timeout: 90_000, polling: 500 },
  );

  const initial = await page.evaluate(() => globalThis.__venomSlime!);
  expect(initial.pinned).toBe(false);
  expect(initial.initialScale).toBeGreaterThan(initial.minScale);
  expect(initial.initialBufferWidth).toBeGreaterThan(1);

  // SwiftShader misses hard at the opening fraction: the controller must
  // shed at least once and land well below where it started.
  await page.waitForFunction(
    () => {
      const t = globalThis.__venomSlime;
      return !!t && t.changes >= 1 && t.scale <= t.initialScale * 0.75;
    },
    undefined,
    { timeout: 90_000, polling: 500 },
  );

  const degraded = await page.evaluate(() => globalThis.__venomSlime!);
  expect(degraded.scale).toBeGreaterThanOrEqual(degraded.minScale);

  // The shed fraction must reach the actual drawing buffer: the GLView is
  // laid out smaller, so the buffer settles below its first real size and
  // well below the unshed opening fraction. Both sides of that proof come
  // from renderer-side telemetry, never from a "before" snapshot taken by
  // the test — SwiftShader can finish adapting before Playwright gets its
  // first telemetry read, which makes a test-captured baseline already
  // post-shed and a before/after comparison unsatisfiable.
  await page.waitForFunction(
    () => {
      const t = globalThis.__venomSlime;
      return (
        !!t &&
        t.bufferWidth > 1 &&
        t.bufferWidth < t.initialBufferWidth &&
        t.bufferFraction > 0 &&
        t.bufferFraction <= t.initialScale * 0.8
      );
    },
    undefined,
    { timeout: 60_000, polling: 500 },
  );

  // Degraded, not frozen: frames keep advancing at the smaller surface.
  const before = await page.evaluate(() => globalThis.__venomSlime!.frames);
  await page.waitForFunction(
    (seen) => (globalThis.__venomSlime?.frames ?? 0) >= seen + 5,
    before,
    { timeout: 30_000, polling: 500 },
  );
});

test('parks the goo loop while another workspace tab is selected', async ({
  page,
}) => {
  // Pinned fraction, detected (software) tier: the subject is the loop
  // stopping, not adaptation, so keep each frame cheap and deterministic.
  await page.goto('/?venomUiTest=true&brainFixture=dense&slimeScale=0.35');
  const brainTab = page.getByRole('tab', { name: 'Open Brain workspace' });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('knowledge-map')).toHaveAttribute(
    'aria-label',
    /Living ontology with 5 selectable/,
  );

  // Real pixels are being shaded while the Brain tab is on screen.
  await page.waitForFunction(
    () => (globalThis.__venomSlime?.frames ?? 0) >= 3,
    undefined,
    { timeout: 90_000, polling: 250 },
  );

  // Page away. Once `paused` flips, the pending callback has been cancelled,
  // so the frame counter it left behind is final.
  await page.getByRole('tab', { name: 'Open Chat workspace' }).click();
  await page.waitForFunction(
    () => globalThis.__venomSlime?.paused === true,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const parked = await page.evaluate(() => globalThis.__venomSlime!.frames);
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => globalThis.__venomSlime!.frames)).toBe(
    parked,
  );

  // Returning to the Brain resumes shading where it left off.
  await brainTab.click();
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');
  await page.waitForFunction(
    (seen) => (globalThis.__venomSlime?.frames ?? 0) > seen,
    parked,
    { timeout: 90_000, polling: 250 },
  );
});

test('a pinned surface fraction stays fixed for deterministic captures', async ({
  page,
}) => {
  await page.goto(
    '/?venomUiTest=true&brainFixture=dense&slimeTier=medium&slimeScale=0.4',
  );
  const brainTab = page.getByRole('tab', { name: 'Open Brain workspace' });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');

  await page.waitForFunction(
    () => (globalThis.__venomSlime?.frames ?? 0) >= 3,
    undefined,
    { timeout: 90_000, polling: 500 },
  );

  const pinned = await page.evaluate(() => globalThis.__venomSlime!);
  expect(pinned.pinned).toBe(true);
  expect(pinned.scale).toBeCloseTo(0.4, 5);
  expect(pinned.changes).toBe(0);
});
