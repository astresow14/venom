import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The symbiote slime is a decorative WebGL layer behind the Brain map. Its
 * contract is to fail soft: no context, a rejected program, or a lost GPU
 * context must leave the ordinary map — nodes, labels, camera controls —
 * fully usable, and a restored context must bring the slime back.
 *
 * These specs drive all three failure paths against the real page. GL
 * activity is observed by instrumenting the context prototypes before any
 * app code runs: `draws` counts drawArrays calls on a live (non-lost)
 * context, `links` counts program links, so "the slime never rendered" and
 * "the slime was rebuilt" are both directly measurable.
 */

type Camera = { yaw: number; pitch: number; zoom: number };

const CAMERA_PATTERN =
  /Camera yaw (-?\d+\.\d+), pitch (-?\d+\.\d+), zoom (-?\d+\.\d+)\./;

declare global {
  interface Window {
    __slimeGl?: { draws: number; links: number };
    __slimeLose?: WEBGL_lose_context | null;
  }
}

async function camera(map: Locator): Promise<Camera> {
  const label = await map.getAttribute('aria-label');
  const match = label?.match(CAMERA_PATTERN);
  expect(match, `camera telemetry missing from ${label}`).not.toBeNull();
  return {
    yaw: Number(match?.[1]),
    pitch: Number(match?.[2]),
    zoom: Number(match?.[3]),
  };
}

async function dragFrom(page: Page, target: Locator, dx: number, dy: number) {
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

/** Count GL draw and link calls no matter which context flavour serves them. */
function installGlCounters(page: Page) {
  return page.addInitScript(() => {
    window.__slimeGl = { draws: 0, links: 0 };
    const instrument = (proto: WebGLRenderingContext) => {
      const draw = proto.drawArrays;
      proto.drawArrays = function (
        this: WebGLRenderingContext,
        mode: number,
        first: number,
        count: number,
      ) {
        // Draw calls against a lost context are silent no-ops; only count
        // frames the GPU could actually have shown.
        if (!this.isContextLost()) window.__slimeGl!.draws += 1;
        return draw.call(this, mode, first, count);
      };
      const link = proto.linkProgram;
      proto.linkProgram = function (
        this: WebGLRenderingContext,
        program: WebGLProgram,
      ) {
        window.__slimeGl!.links += 1;
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

/**
 * Simulate a context whose uniform budget is below the smallest slime tier,
 * the path renderer.ts guards with MAX_FRAGMENT_UNIFORM_VECTORS.
 */
function starveUniformBudget(page: Page) {
  return page.addInitScript(() => {
    const MAX_FRAGMENT_UNIFORM_VECTORS = 0x8dfd;
    const starve = (proto: WebGLRenderingContext) => {
      const original = proto.getParameter;
      proto.getParameter = function (this: WebGLRenderingContext, pname: number) {
        if (pname === MAX_FRAGMENT_UNIFORM_VECTORS) return 8;
        return original.call(this, pname);
      };
    };
    starve(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      starve(WebGL2RenderingContext.prototype as unknown as WebGLRenderingContext);
    }
  });
}

const draws = (page: Page) =>
  page.evaluate(() => window.__slimeGl?.draws ?? 0);
const links = (page: Page) =>
  page.evaluate(() => window.__slimeGl?.links ?? 0);

/** The full map contract: nodes, labels, orbit, zoom and reset all work. */
async function expectMapFullyUsable(page: Page, map: Locator) {
  const node = map.getByRole('button', {
    name: 'Node: Product Context',
    exact: true,
  });
  await expect(node).toBeVisible();
  await expect(node).toContainText('Product Context');

  const initial = await camera(map);

  await dragFrom(page, node, 130, -70);
  const moved = await camera(map);
  expect(Math.abs(moved.yaw - initial.yaw)).toBeGreaterThan(0.5);
  expect(Math.abs(moved.pitch - initial.pitch)).toBeGreaterThan(0.25);

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect
    .poll(async () => (await camera(map)).zoom)
    .toBeGreaterThan(moved.zoom);

  await page.getByRole('button', { name: 'Align', exact: true }).click();
  await expect.poll(() => camera(map)).toEqual(initial);
}

test('map stays fully usable when WebGL is unavailable', async ({ page }) => {
  await installGlCounters(page);
  await blockWebGl(page);
  await page.goto('/workspace/brain?brainFixture=dense');

  const map = page.getByRole('region', { name: /Knowledge map with 5 nodes/ });
  await expect(map).toBeVisible();

  // The layer mounted and failed soft — the canvas is there, just inert.
  await expect(map.locator('canvas')).toHaveCount(1);

  await expectMapFullyUsable(page, map);

  // Nothing was ever drawn through any GL context.
  expect(await draws(page)).toBe(0);
});

test('map stays fully usable when the slime program is rejected', async ({
  page,
}) => {
  await installGlCounters(page);
  await starveUniformBudget(page);
  await page.goto('/workspace/brain?brainFixture=dense');

  const map = page.getByRole('region', { name: /Knowledge map with 5 nodes/ });
  await expect(map).toBeVisible();
  await expect(map.locator('canvas')).toHaveCount(1);

  await expectMapFullyUsable(page, map);

  // The uniform-budget check rejected the program before it was ever built.
  expect(await links(page)).toBe(0);
  expect(await draws(page)).toBe(0);
});

test('slime survives a lost GPU context and comes back on restore', async ({
  page,
}) => {
  await installGlCounters(page);
  await page.goto('/workspace/brain?brainFixture=dense');

  const map = page.getByRole('region', { name: /Knowledge map with 5 nodes/ });
  await expect(map).toBeVisible();

  // The slime is genuinely alive before we pull the context out from under it.
  await expect.poll(() => draws(page), { timeout: 15_000 }).toBeGreaterThan(0);
  const linksBefore = await links(page);
  expect(linksBefore).toBeGreaterThan(0);

  await page.evaluate(() => {
    const canvas = document.querySelector('main[role="region"] canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('slime canvas missing');
    }
    const gl = (canvas.getContext('webgl') ??
      canvas.getContext('webgl2')) as WebGLRenderingContext | null;
    if (!gl) throw new Error('slime context missing');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (!lose) throw new Error('WEBGL_lose_context unsupported');
    window.__slimeLose = lose;
    lose.loseContext();
  });

  // The render loop stops instead of hammering a dead context.
  await expect
    .poll(
      async () => {
        const before = await draws(page);
        await page.waitForTimeout(250);
        return (await draws(page)) - before;
      },
      { timeout: 10_000 },
    )
    .toBe(0);

  // The map itself never noticed: nodes and camera stay live while the GL
  // layer is down.
  const during = await camera(map);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect
    .poll(async () => (await camera(map)).zoom)
    .toBeGreaterThan(during.zoom);
  await expect(
    map.getByRole('button', { name: 'Node: Product Context', exact: true }),
  ).toBeVisible();

  const stalled = await draws(page);
  await page.evaluate(() => {
    window.__slimeLose?.restoreContext();
  });

  // Restoration rebuilds the program and drawing resumes — the slime comes
  // back rather than staying dead.
  await expect
    .poll(() => links(page), { timeout: 15_000 })
    .toBeGreaterThan(linksBefore);
  await expect
    .poll(() => draws(page), { timeout: 15_000 })
    .toBeGreaterThan(stalled);

  // And the map is still intact afterwards.
  await expect(
    map.getByRole('button', { name: 'Node: Product Context', exact: true }),
  ).toBeVisible();
});
