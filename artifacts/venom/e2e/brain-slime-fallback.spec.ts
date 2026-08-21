import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The symbiote slime under the mobile Brain map is an expo-gl GLView. Its
 * contract matches the desktop layer: when this runtime cannot serve the 3D
 * layer — no WebGL at all, or a context too weak to hold the program — the
 * surface renders nothing and the ordinary map keeps working; a lost context
 * that is later restored brings the slime back.
 *
 * GL activity is observed by instrumenting the context prototypes before any
 * app code runs: `draws` counts drawArrays calls on a live (non-lost)
 * context, `links` counts program links, so "the slime never rendered" and
 * "the slime was rebuilt" are both directly measurable.
 */

type Camera = { yaw: number; pitch: number; zoom: number };

const CAMERA_PATTERN =
  /Camera yaw (-?\d+\.\d+), pitch (-?\d+\.\d+), zoom (-?\d+\.\d+)/;

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

async function openBrain(page: Page) {
  await page.goto('/?venomUiTest=true&brainFixture=dense');
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

async function dragMap(page: Page, map: Locator, dx: number, dy: number) {
  const bounds = await map.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + Math.min(bounds.height * 0.55, 300);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 14 });
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
      proto.getParameter = function (
        this: WebGLRenderingContext,
        pname: number,
      ) {
        if (pname === MAX_FRAGMENT_UNIFORM_VECTORS) return 8;
        return original.call(this, pname);
      };
    };
    starve(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      starve(
        WebGL2RenderingContext.prototype as unknown as WebGLRenderingContext,
      );
    }
  });
}

const draws = (page: Page) =>
  page.evaluate(() => window.__slimeGl?.draws ?? 0);
const links = (page: Page) =>
  page.evaluate(() => window.__slimeGl?.links ?? 0);

/** Orbit, cluster selection and reset — the map contract that must survive. */
async function expectMapFullyUsable(page: Page, map: Locator) {
  const initial = await camera(map);

  await dragMap(page, map, 105, -58);
  const moved = await camera(map);
  expect(Math.abs(moved.yaw - initial.yaw)).toBeGreaterThan(0.45);
  expect(Math.abs(moved.pitch - initial.pitch)).toBeGreaterThan(0.2);

  await page.getByTestId('knowledge-cluster-1').click();
  await expect(page.getByTestId('knowledge-cluster-details')).toBeVisible();
  await page.getByRole('button', { name: 'Close cluster details' }).click();

  await page.getByTestId('knowledge-reset-view').click();
  expect(await camera(map)).toEqual(initial);
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile-chromium',
    'The GLView slime layer backs the mobile Brain workspace.',
  );
});

test('map stays usable when WebGL is unavailable', async ({ page }) => {
  await installGlCounters(page);
  await blockWebGl(page);
  const map = await openBrain(page);

  await expectMapFullyUsable(page, map);

  // Nothing was ever drawn through any GL context.
  expect(await draws(page)).toBe(0);
});

test('map stays usable when the slime program is rejected', async ({
  page,
}) => {
  await installGlCounters(page);
  await starveUniformBudget(page);
  const map = await openBrain(page);

  // The GL surface mounted, then failed soft: it is there but inert.
  await expect(map.locator('canvas')).toHaveCount(1);

  await expectMapFullyUsable(page, map);

  // The uniform-budget check rejected the program before it was ever built.
  expect(await links(page)).toBe(0);
  expect(await draws(page)).toBe(0);
});

test('slime returns after the GL context is lost and restored', async ({
  page,
}) => {
  await installGlCounters(page);
  const map = await openBrain(page);

  // The slime is genuinely alive before we pull the context out from under it.
  await expect.poll(() => draws(page), { timeout: 20_000 }).toBeGreaterThan(0);
  const linksBefore = await links(page);
  expect(linksBefore).toBeGreaterThan(0);

  await map.locator('canvas').first().evaluate((element) => {
    const target = element as HTMLCanvasElement;
    const gl = (target.getContext('webgl2') ??
      target.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) throw new Error('slime context missing');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (!lose) throw new Error('WEBGL_lose_context unsupported');
    window.__slimeLose = lose;
    lose.loseContext();
  });

  // Live drawing stops while the context is down.
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

  // The map itself never noticed: orbit still works while the layer is dark.
  const during = await camera(map);
  await dragMap(page, map, 80, -40);
  expect(await camera(map)).not.toEqual(during);

  const stalled = await draws(page);
  await page.evaluate(() => {
    window.__slimeLose?.restoreContext();
  });

  // Restoration rebuilds the program and drawing resumes — the slime comes
  // back rather than staying dead.
  await expect
    .poll(() => links(page), { timeout: 20_000 })
    .toBeGreaterThan(linksBefore);
  await expect
    .poll(() => draws(page), { timeout: 20_000 })
    .toBeGreaterThan(stalled);

  // And the map is still intact afterwards.
  await page.getByTestId('knowledge-reset-view').click();
  await expect(page.getByTestId('knowledge-cluster-1')).toBeVisible();
});
