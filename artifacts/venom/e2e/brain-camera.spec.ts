import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';

type Camera = { yaw: number; pitch: number; zoom: number };
type TouchPoint = { x: number; y: number; id: number };

const CAMERA_PATTERN =
  /Camera yaw (-?\d+\.\d+), pitch (-?\d+\.\d+), zoom (-?\d+\.\d+)/;

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

async function openBrain(page: Page, fixture: 'sparse' | 'dense') {
  // slimeTier=off: camera math never touches the goo layer, so skip its
  // SwiftShader context + shader compile (the WebGL-unavailable fallback is
  // a supported state with an identical map contract).
  await page.goto(`/?venomUiTest=true&brainFixture=${fixture}&slimeTier=off`);
  const brainTab = page.getByRole('tab', { name: 'Open Brain workspace' });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');

  const expectedCount = fixture === 'sparse' ? 2 : 5;
  const map = page.getByTestId('knowledge-map');
  await expect(map).toHaveAttribute(
    'aria-label',
    new RegExp(`Living ontology with ${expectedCount} selectable`),
  );
  return { brainTab, map };
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

async function dispatchTouch(
  client: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  touchPoints: TouchPoint[],
) {
  await client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: touchPoints.map((point) => ({
      ...point,
      radiusX: 2,
      radiusY: 2,
      force: 1,
    })),
  });
}

async function pinch(
  page: Page,
  map: Locator,
  movement: (progress: number, center: TouchPoint) => TouchPoint[],
) {
  const bounds = await map.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + Math.min(bounds.height * 0.52, 290),
    id: 0,
  };
  const client = await page.context().newCDPSession(page);
  await dispatchTouch(client, 'touchStart', movement(0, center));
  for (let step = 1; step <= 8; step += 1) {
    await dispatchTouch(client, 'touchMove', movement(step / 8, center));
  }
  await dispatchTouch(client, 'touchEnd', []);
}

async function expectBrainSelected(brainTab: Locator) {
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile-chromium',
    'Mobile Brain gestures run at the Expo root in the touch viewport.',
  );
});

test('keeps one-touch two-axis orbit and cluster actions usable on a dense map', async ({
  page,
}) => {
  const { brainTab, map } = await openBrain(page, 'dense');
  const initial = await camera(map);

  await dragMap(page, map, 105, -58);
  const moved = await camera(map);
  expect(Math.abs(moved.yaw - initial.yaw)).toBeGreaterThan(0.45);
  expect(Math.abs(moved.pitch - initial.pitch)).toBeGreaterThan(0.2);
  expect(moved.zoom).toBe(initial.zoom);

  await page.waitForTimeout(150);
  expect(await camera(map)).toEqual(moved);
  await expectBrainSelected(brainTab);

  await page.getByTestId('knowledge-cluster-1').click();
  await expect(page.getByTestId('knowledge-cluster-details')).toBeVisible();
  await page.getByRole('button', { name: 'Close cluster details' }).click();

  await page.getByTestId('knowledge-reset-view').click();
  expect(await camera(map)).toEqual(initial);
});

test('zooms a sparse map with a fixed-centroid pinch without orbiting or paging', async ({
  page,
}) => {
  const { brainTab, map } = await openBrain(page, 'sparse');
  const initial = await camera(map);

  await pinch(page, map, (progress, center) => {
    const distance = 32 + progress * 42;
    return [
      { id: 1, x: center.x - distance, y: center.y },
      { id: 2, x: center.x + distance, y: center.y },
    ];
  });

  const pinched = await camera(map);
  expect(pinched.zoom).toBeGreaterThan(initial.zoom + 0.2);
  expect(pinched.yaw).toBe(initial.yaw);
  expect(pinched.pitch).toBe(initial.pitch);
  await expectBrainSelected(brainTab);

  await page.getByTestId('knowledge-reset-view').click();
  expect(await camera(map)).toEqual(initial);
});

test('isolates a translated-centroid pinch from orbit and workspace navigation', async ({
  page,
}) => {
  const { brainTab, map } = await openBrain(page, 'dense');
  const initial = await camera(map);

  await pinch(page, map, (progress, center) => {
    const distance = 42;
    const translatedX = center.x + progress * 66;
    const translatedY = center.y - progress * 24;
    return [
      { id: 1, x: translatedX - distance, y: translatedY },
      { id: 2, x: translatedX + distance, y: translatedY },
    ];
  });

  const pinched = await camera(map);
  expect(Math.abs(pinched.zoom - initial.zoom)).toBeLessThan(0.03);
  expect(pinched.yaw).toBe(initial.yaw);
  expect(pinched.pitch).toBe(initial.pitch);
  await expectBrainSelected(brainTab);
});

test.describe('reduced motion', () => {
  test('keeps manual orbit and reset available', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { brainTab, map } = await openBrain(page, 'sparse');
    await expect(page.getByText('Motion reduced · drag to orbit')).toBeVisible();
    const initial = await camera(map);

    await dragMap(page, map, -86, 48);
    expect(await camera(map)).not.toEqual(initial);
    await expectBrainSelected(brainTab);

    await page.getByTestId('knowledge-reset-view').click();
    expect(await camera(map)).toEqual(initial);
  });
});