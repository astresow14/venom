import { expect, test, type Locator, type Page } from '@playwright/test';

import { slimeCapacityForTierName } from '../../../lib/slime/src';

/**
 * Still-frame proof that the rich slime tiers actually put goo on screen.
 *
 * Device detection (correctly) hands SwiftShader — the rasterizer behind
 * every automated browser here — the sparse software tier, so the dense
 * satellite clusters, droplet colony and links that real phones see are
 * never rasterized by the other suites. A packing or shader regression that
 * only exists above the sparse caps would ship green. `slimeTier=` pins the
 * renderer tier and `slimeScale=` pins the surface fraction, which makes one
 * still frame per tier affordable; the assertion is alpha coverage — is a
 * living layer present at all — never pixel-perfect appearance.
 */

const TIERS = ['full', 'medium', 'compact'] as const;

/** Keep the pinned surface small: stills need pixels, not resolution. */
const STILL_SURFACE_FRACTION = 0.3;

/** Sampled drawing-buffer alpha coverage; fraction is -1 when unreadable. */
type Coverage = {
  width: number;
  height: number;
  fraction: number;
  note: string;
};

type TierTelemetry = {
  pinned: boolean;
  frames: number;
  dropCount?: number;
  capacity?: { blobs: number; links: number; drops: number };
};

const readTelemetry = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as { __venomSlime?: TierTelemetry }).__venomSlime ?? null,
  );

async function openDenseBrain(page: Page, tier: string) {
  await page.goto(
    `/?venomUiTest=true&brainFixture=dense&slimeTier=${tier}&slimeScale=${STILL_SURFACE_FRACTION}`,
  );
  const brainTab = page.getByRole('tab', { name: 'Open Brain workspace' });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');

  const map = page.getByTestId('knowledge-map');
  await expect(map).toHaveAttribute(
    'aria-label',
    /Living ontology with 5 selectable/,
  );
  return map;
}

/**
 * Read back the slime drawing buffer and measure how much of it is covered
 * by non-transparent pixels. The buffer is not preserved between frames, so
 * the read happens inside a requestAnimationFrame callback: the render loop
 * re-arms itself at the end of every draw, which means a callback registered
 * now runs in the next frame *after* that frame's draw — while the pixels
 * are still in the buffer.
 */
function sampleCoverage(canvas: Locator): Promise<Coverage> {
  return canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    const gl = (target.getContext('webgl2') ??
      target.getContext('webgl') ??
      target.getContext(
        'experimental-webgl',
      )) as WebGLRenderingContext | null;
    if (!gl) {
      return {
        width: 0,
        height: 0,
        fraction: -1,
        note: 'no WebGL context on the slime canvas',
      };
    }
    return new Promise<Coverage>((resolve) => {
      requestAnimationFrame(() => {
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (width <= 1 || height <= 1) {
          resolve({
            width,
            height,
            fraction: -1,
            note: 'surface not laid out yet',
          });
          return;
        }
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let covered = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] > 8) covered += 1;
        }
        resolve({
          width,
          height,
          fraction: covered / (width * height),
          note: 'ok',
        });
      });
    });
  });
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile-chromium',
    'The GLView slime layer backs the mobile Brain workspace.',
  );
});

for (const tier of TIERS) {
  test(`${tier} tier still frame keeps the living layer visible`, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    const map = await openDenseBrain(page, tier);
    const canvas = map.locator('canvas');
    await expect(canvas).toHaveCount(1);

    // Let the colony populate: frames only count once real pixels are being
    // shaded (the web surface starts 1x1), and droplets need a few simulated
    // steps before their radii grow past zero.
    await page.waitForFunction(
      () =>
        ((globalThis as { __venomSlime?: { frames?: number } }).__venomSlime
          ?.frames ?? 0) >= 8,
      undefined,
      { timeout: 90_000, polling: 500 },
    );

    const telemetry = await readTelemetry(page);
    expect(
      telemetry,
      'slime telemetry missing — did the GL layer build?',
    ).not.toBeNull();
    expect(
      telemetry!.pinned,
      'slimeScale pin must disable adaptation for a deterministic still',
    ).toBe(true);

    // The renderer must have compiled the *pinned* tier. A silently ignored
    // override would fall back to device detection, hand SwiftShader the
    // sparse software field, and this check would prove nothing.
    expect(
      telemetry!.capacity,
      `renderer must compile the pinned ${tier} tier`,
    ).toEqual(slimeCapacityForTierName(tier));

    expect(
      telemetry!.dropCount ?? 0,
      'droplet colony never populated the packed field',
    ).toBeGreaterThan(0);

    // The actual living-look check: the goo layer covers a meaningful slice
    // of the stage. A blank canvas reads 0; a buffer that lost transparency
    // (or a shader spraying the whole surface) reads ~1. Both are broken.
    await expect
      .poll(async () => (await sampleCoverage(canvas)).fraction, {
        message: `${tier} tier drawing buffer shows no goo coverage`,
        timeout: 60_000,
      })
      .toBeGreaterThan(0.015);
    expect((await sampleCoverage(canvas)).fraction).toBeLessThan(0.98);

    expect(pageErrors, 'page errors while rendering the still').toEqual([]);
  });
}
