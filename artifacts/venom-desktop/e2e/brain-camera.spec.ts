import { expect, test, type Locator, type Page } from '@playwright/test';

type Camera = { yaw: number; pitch: number; zoom: number };

const CAMERA_PATTERN =
  /Camera yaw (-?\d+\.\d+), pitch (-?\d+\.\d+), zoom (-?\d+\.\d+)\./;

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

async function expectCameraToStay(map: Locator, expected: Camera) {
  await expect
    .poll(() => camera(map))
    .toEqual(expected);
}

test('persists two-axis orbit, distinguishes drag from click, and resets from the keyboard', async ({
  page,
}) => {
  await page.goto('/workspace/brain?brainFixture=dense');

  const map = page.getByRole('region', { name: /Knowledge map with 5 nodes/ });
  await expect(map).toBeVisible();
  const initial = await camera(map);
  const matchingNode = map.getByRole('button', {
    name: 'Node: Product Context',
    exact: true,
  });

  await dragFrom(page, matchingNode, 130, -70);
  const moved = await camera(map);
  expect(Math.abs(moved.yaw - initial.yaw)).toBeGreaterThan(0.5);
  expect(Math.abs(moved.pitch - initial.pitch)).toBeGreaterThan(0.25);
  await page.waitForTimeout(150);
  await expectCameraToStay(map, moved);
  await expect(page.getByLabel('Close details')).toHaveCount(0);

  await page.getByLabel('Search map').fill('Product Context');
  await matchingNode.click();
  await expect(page.getByRole('heading', { name: 'Product Context' })).toBeVisible();
  await page.getByLabel('Close details').click();

  const reset = page.getByRole('button', { name: 'Align', exact: true });
  await reset.focus();
  await page.keyboard.press('Enter');
  await expectCameraToStay(map, initial);
});

test('keeps wheel and button zoom stable on a sparse map', async ({ page }) => {
  await page.goto('/workspace/brain?brainFixture=sparse');

  const map = page.getByRole('region', { name: /Knowledge map with 2 nodes/ });
  await expect(map).toBeVisible();
  const initial = await camera(map);
  const bounds = await map.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  await map.dispatchEvent('wheel', { deltaY: -180, bubbles: true });
  await expect
    .poll(async () => (await camera(map)).zoom)
    .toBeGreaterThan(initial.zoom);
  const wheelZoom = await camera(map);
  expect(wheelZoom.zoom).toBeGreaterThan(initial.zoom);
  await expectCameraToStay(map, wheelZoom);

  await page.getByRole('button', { name: 'Zoom out' }).click();
  const buttonZoom = await camera(map);
  expect(buttonZoom.zoom).toBeLessThan(wheelZoom.zoom);

  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect((await camera(map)).zoom).toBeGreaterThan(buttonZoom.zoom);

  await page.getByRole('button', { name: 'Align', exact: true }).click();
  await expectCameraToStay(map, initial);
});