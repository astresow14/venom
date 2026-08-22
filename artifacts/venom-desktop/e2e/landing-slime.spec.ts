import { expect, test, type Locator, type Page } from '@playwright/test';

import { slimeCapacityForTierName } from '../../../lib/slime/src';

/**
 * The landing page's living backdrop: a symbiote organism that breathes on
 * its own, reaches toward the cursor, holds perfectly still under reduced
 * motion, and vanishes without a trace when WebGL is unavailable.
 *
 * Device detection hands SwiftShader the sparse software tier, so these
 * specs pin `slimeTier=full` + a small `slimeScale` exactly like the Brain
 * map stills: the assertions are about presence, reaction and stillness —
 * never pixel-perfect appearance. The layer must also never get between
 * the user and the composer, so every path re-proves the prompt still
 * submits.
 */

const PINNED = '/?slimeTier=full&slimeScale=0.35';

type LandingTelemetry = {
  pinned: boolean;
  frames: number;
  capacity?: { blobs: number; links: number; drops: number };
  dropCount: number;
  pointerWeight: number;
  pointerTouched: number;
  frozen: boolean;
  fieldChecksum: number;
  maxBlobRadius: number;
};

const readTelemetry = (page: Page) =>
  page.evaluate(
    () =>
      (window as { __venomLandingSlime?: LandingTelemetry })
        .__venomLandingSlime ?? null,
  );

/** Sampled drawing-buffer alpha coverage; fraction is -1 when unreadable. */
type Coverage = { width: number; height: number; fraction: number; note: string };

/**
 * Read back the slime drawing buffer inside a requestAnimationFrame
 * callback — the loop re-arms at the end of every draw, so a callback
 * registered now runs right after the next draw while the (unpreserved)
 * buffer still holds that frame's pixels.
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
        note: 'no WebGL context on the landing canvas',
      };
    }
    return new Promise<Coverage>((resolve) => {
      requestAnimationFrame(() => {
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (width <= 1 || height <= 1) {
          resolve({ width, height, fraction: -1, note: 'surface not laid out' });
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

/** Count GL draw calls no matter which context flavour serves them. */
function installGlCounters(page: Page) {
  return page.addInitScript(() => {
    (window as { __slimeGl?: { draws: number; links: number } }).__slimeGl = {
      draws: 0,
      links: 0,
    };
    const counters = (
      window as unknown as { __slimeGl: { draws: number; links: number } }
    ).__slimeGl;
    const instrument = (proto: WebGLRenderingContext) => {
      const draw = proto.drawArrays;
      proto.drawArrays = function (
        this: WebGLRenderingContext,
        mode: number,
        first: number,
        count: number,
      ) {
        if (!this.isContextLost()) counters.draws += 1;
        return draw.call(this, mode, first, count);
      };
      const link = proto.linkProgram;
      proto.linkProgram = function (
        this: WebGLRenderingContext,
        program: WebGLProgram,
      ) {
        counters.links += 1;
        return link.call(this, program);
      };
    };
    instrument(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      instrument(
        WebGL2RenderingContext.prototype as unknown as WebGLRenderingContext,
      );
    }
  });
}

/** Simulate a browser with WebGL disabled (blocklisted GPU, locked-down profile). */
function blockWebGl(page: Page) {
  return page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (typeof type === 'string' && type.toLowerCase().includes('webgl')) {
        return null;
      }
      return (original as (...args: unknown[]) => unknown).call(
        this,
        type,
        ...rest,
      );
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

/** The landing hero, ready: Clerk resolved signed-out and the composer is up. */
async function openLanding(page: Page, path: string) {
  await page.goto(path);
  const prompt = page.getByLabel('Ask Venom');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  return prompt;
}

/** The backdrop mounts on idle, after first paint — wait for it. */
async function landingCanvas(page: Page) {
  const canvas = page.getByTestId('landing-slime');
  await expect(canvas).toHaveCount(1, { timeout: 20_000 });
  return canvas;
}

/** Wait until the render loop has produced a few real frames. */
function waitForFrames(page: Page, minimum: number) {
  return page.waitForFunction(
    (min) =>
      ((window as { __venomLandingSlime?: { frames?: number } })
        .__venomLandingSlime?.frames ?? 0) >= min,
    minimum,
    { timeout: 90_000, polling: 500 },
  );
}

/** The composer must submit exactly as it does without the backdrop. */
async function expectComposerSubmits(page: Page, prompt: Locator) {
  await prompt.fill('What are you?');
  await prompt.press('Enter');
  await page.waitForURL('**/sign-in**', { timeout: 30_000 });
}

test('the landing hero rises over a living, populated symbiote layer', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const prompt = await openLanding(page, PINNED);
  const canvas = await landingCanvas(page);

  // The layer is decoration: inert to the pointer and invisible to
  // assistive tech, by contract.
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  await expect(canvas).toHaveClass(/pointer-events-none/);

  await waitForFrames(page, 8);

  const telemetry = await readTelemetry(page);
  expect(telemetry, 'landing slime telemetry missing').not.toBeNull();
  expect(
    telemetry!.pinned,
    'slimeScale pin must disable adaptation for a deterministic still',
  ).toBe(true);
  expect(
    telemetry!.capacity,
    'renderer must compile the pinned full tier',
  ).toEqual(slimeCapacityForTierName('full'));
  expect(
    telemetry!.dropCount,
    'the droplet colony never populated the landing field',
  ).toBeGreaterThan(0);

  // Alive and translucent: goo covers a meaningful slice of the stage but
  // never floods it — the hero column stays near-black by composition.
  await expect
    .poll(async () => (await sampleCoverage(canvas)).fraction, {
      message: 'landing drawing buffer shows no goo coverage',
      timeout: 60_000,
    })
    .toBeGreaterThan(0.015);
  expect((await sampleCoverage(canvas)).fraction).toBeLessThan(0.98);

  // Once drawn, the layer fades in over the page.
  await expect(canvas).toHaveClass(/opacity-100/);

  // The effect never gets between the user and the composer.
  await expectComposerSubmits(page, prompt);

  expect(pageErrors, 'page errors while rendering the landing').toEqual([]);
});

test('the mass reaches toward the cursor and relaxes when it leaves', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await openLanding(page, PINNED);
  const canvas = await landingCanvas(page);
  await waitForFrames(page, 8);

  // Nothing has hovered yet: the attractor is dormant.
  const dormant = await readTelemetry(page);
  expect(dormant!.pointerWeight).toBeLessThan(0.05);

  // Ambient size of the biggest core before the cursor arrives.
  const baselineRadius = dormant!.maxBlobRadius;
  expect(baselineRadius).toBeGreaterThan(0);

  // Glide onto the deep-corner mass (bottom-left of the pane) the way a
  // real cursor would, generating a stream of pointermove events.
  const box = (await canvas.boundingBox())!;
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.move(
    box.x + box.width * 0.1,
    box.y + box.height * 0.88,
    { steps: 15 },
  );

  // The material notices: presence eases in and nearby nodes are touched.
  await expect
    .poll(
      async () => {
        const t = await readTelemetry(page);
        return t ? t.pointerWeight : 0;
      },
      { message: 'pointer presence never eased in', timeout: 60_000 },
    )
    .toBeGreaterThan(0.5);
  expect((await readTelemetry(page))!.pointerTouched).toBeGreaterThan(0);

  // And it physically swells: the packed geometry grows past its ambient
  // size (breathing alone stays within a few percent).
  await expect
    .poll(
      async () => {
        const t = await readTelemetry(page);
        return t ? t.maxBlobRadius / baselineRadius : 0;
      },
      { message: 'the mass never swelled toward the cursor', timeout: 60_000 },
    )
    .toBeGreaterThan(1.06);

  // The cursor leaves the window: the organism settles back to ambient.
  await page.evaluate(() =>
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave')),
  );
  await expect
    .poll(
      async () => {
        const t = await readTelemetry(page);
        return t ? t.pointerWeight : 1;
      },
      { message: 'pointer presence never released', timeout: 60_000 },
    )
    .toBeLessThan(0.1);

  expect(pageErrors, 'page errors during the pointer dance').toEqual([]);
});

test('reduced motion keeps the sculpture present but perfectly still', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLanding(page, PINNED);
  const canvas = await landingCanvas(page);
  await waitForFrames(page, 8);

  const initial = await readTelemetry(page);
  expect(initial!.frozen, 'reduced motion must freeze the organism').toBe(true);

  // Present: the sculpted mass still covers part of the stage.
  await expect
    .poll(async () => (await sampleCoverage(canvas)).fraction, {
      message: 'reduced-motion still shows no sculpted mass',
      timeout: 60_000,
    })
    .toBeGreaterThan(0.015);

  // Perfectly still: frames keep rendering, geometry never changes.
  const before = await readTelemetry(page);
  await waitForFrames(page, before!.frames + 3);
  const after = await readTelemetry(page);
  expect(after!.fieldChecksum, 'the frozen field drifted').toBe(
    before!.fieldChecksum,
  );

  // The attractor is inert too: hovering the mass moves nothing.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.88, {
    steps: 8,
  });
  await waitForFrames(page, after!.frames + 3);
  const hovered = await readTelemetry(page);
  expect(hovered!.pointerWeight, 'frozen slime chased the cursor').toBe(0);
  expect(hovered!.fieldChecksum, 'hover deformed the frozen field').toBe(
    before!.fieldChecksum,
  );

  expect(pageErrors, 'page errors under reduced motion').toEqual([]);
});

test('no WebGL leaves the plain landing untouched', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await installGlCounters(page);
  await blockWebGl(page);

  const prompt = await openLanding(page, '/');
  const canvas = await landingCanvas(page);

  // The canvas mounted, failed soft, and never revealed itself: fully
  // transparent, so the user sees exactly the static near-black page.
  await expect(canvas).toHaveClass(/opacity-0/);
  expect(
    await page.evaluate(
      () =>
        (window as { __venomLandingSlime?: unknown }).__venomLandingSlime ===
        undefined,
    ),
    'telemetry must never initialise without a GL context',
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as { __slimeGl?: { draws: number } }).__slimeGl?.draws ?? -1,
    ),
    'nothing may ever be drawn without WebGL',
  ).toBe(0);

  // The page is not just intact but fully usable.
  await expectComposerSubmits(page, prompt);

  expect(pageErrors, 'page errors on the no-WebGL landing').toEqual([]);
});
