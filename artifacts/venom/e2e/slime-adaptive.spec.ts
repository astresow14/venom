import { expect, test, type Page } from '@playwright/test';

/**
 * Adaptive slime quality on the phone map, measured on the dense fixture.
 *
 * Headless Chromium rasterizes with SwiftShader — a stand-in for the older
 * phones this exists for. `slimeTier=full` pins the rich shader (device
 * detection would otherwise hand a software rasterizer the sparse tier), so
 * the frame-time controller must shrink the GL surface instead of letting
 * the map stutter.
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

declare global {
  // eslint-disable-next-line no-var
  var __venomSlime: Telemetry | undefined;
}

async function openDenseBrain(page: Page) {
  await page.goto('/?venomUiTest=true&brainFixture=dense&slimeTier=full');
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
  // laid out smaller, so the buffer ends up smaller than it began.
  await page.waitForFunction(
    (initialWidth) => {
      const t = globalThis.__venomSlime;
      return !!t && t.bufferWidth > 1 && t.bufferWidth < initialWidth;
    },
    initial.bufferWidth,
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

test('a pinned surface fraction stays fixed for deterministic captures', async ({
  page,
}) => {
  await page.goto(
    '/?venomUiTest=true&brainFixture=dense&slimeTier=full&slimeScale=0.4',
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
