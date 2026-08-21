import { expect, test, type Page } from '@playwright/test';

/**
 * Adaptive slime quality, measured on the dense map.
 *
 * Headless Chromium rasterizes WebGL with SwiftShader, which cannot hold the
 * full-tier raymarch at the opening render scale — exactly the situation an
 * older phone is in. `slimeTier=full` pins the rich shader (device detection
 * would otherwise hand SwiftShader the sparse tier), so the controller must
 * shed resolution instead of letting the page crawl.
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
};

async function telemetry(page: Page): Promise<Telemetry> {
  const state = await page.evaluate(() => window.__venomSlime ?? null);
  expect(state, 'slime telemetry missing — did the GL layer build?').not.toBeNull();
  return state as Telemetry;
}

test('sheds render scale under load on the dense map instead of stuttering', async ({
  page,
}) => {
  await page.goto('/workspace/brain?brainFixture=dense&slimeTier=full');

  await expect(
    page.getByRole('region', { name: /Knowledge map with 5 nodes/ }),
  ).toBeVisible();

  // The GL layer is up once frames are being counted.
  await page.waitForFunction(
    () => (window.__venomSlime?.frames ?? 0) > 0,
    undefined,
    { timeout: 60_000, polling: 500 },
  );

  const initial = await telemetry(page);
  expect(initial.pinned).toBe(false);
  expect(initial.initialScale).toBeGreaterThan(initial.minScale);

  // SwiftShader misses hard at the opening scale, so the controller must
  // react with at least one degrade decision and end up well below it.
  await page.waitForFunction(
    () => {
      const t = window.__venomSlime;
      return !!t && t.changes >= 1 && t.scale <= t.initialScale * 0.75;
    },
    undefined,
    { timeout: 90_000, polling: 500 },
  );

  const degraded = await telemetry(page);
  expect(degraded.scale).toBeGreaterThanOrEqual(degraded.minScale);
  // Shedding scale must actually shrink the surface being shaded.
  expect(degraded.bufferWidth).toBeLessThan(
    Math.round((degraded.bufferWidth / degraded.scale) * degraded.initialScale),
  );

  // Quality degraded *instead of* the loop freezing: frames keep advancing
  // at the shed scale.
  const before = degraded.frames;
  await page.waitForFunction(
    (seen) => (window.__venomSlime?.frames ?? 0) >= seen + 5,
    before,
    { timeout: 30_000, polling: 500 },
  );
});

test('a pinned scale stays fixed so captures are deterministic', async ({
  page,
}) => {
  await page.goto(
    '/workspace/brain?brainFixture=dense&slimeTier=full&slimeScale=0.5',
  );

  await expect(
    page.getByRole('region', { name: /Knowledge map with 5 nodes/ }),
  ).toBeVisible();

  await page.waitForFunction(
    () => (window.__venomSlime?.frames ?? 0) >= 3,
    undefined,
    { timeout: 60_000, polling: 500 },
  );

  const pinned = await telemetry(page);
  expect(pinned.pinned).toBe(true);
  expect(pinned.scale).toBeCloseTo(0.5, 5);
  expect(pinned.changes).toBe(0);
});
