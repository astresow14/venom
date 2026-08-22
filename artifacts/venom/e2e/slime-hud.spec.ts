import { expect, test, type Page } from '@playwright/test';

/**
 * Dev goo HUD: the on-device readout used for the real-phone adaptation
 * check (surface fraction, floor/ceiling, buffer, cadence, resize count).
 *
 * The HUD is a native-first tool — on web it only exists behind
 * `?slimeHud=1` so this spec can prove the readout wiring works, while
 * every other browser capture stays free of it. The surface fraction is
 * pinned here so the panel's numbers are deterministic on SwiftShader.
 */

async function openBrainTab(page: Page, query: string) {
  // No `slimeTier` pin: the HUD readout is tier-agnostic and the fraction is
  // pinned, so the detected (cheap) tier keeps SwiftShader frames flowing
  // fast enough to sample.
  await page.goto(`/?venomUiTest=true&brainFixture=dense${query}`);
  const brainTab = page.getByRole('tab', { name: 'Open Brain workspace' });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('knowledge-map')).toBeVisible();
}

test('the goo HUD reads live surface telemetry when opened', async ({
  page,
}) => {
  await openBrainTab(page, '&slimeScale=0.4&slimeHud=1');

  const toggle = page.getByTestId('slime-hud-toggle');
  await expect(toggle).toBeVisible();

  // Nothing is sampled until the panel asks for it.
  await expect(page.getByTestId('slime-hud-panel')).toHaveCount(0);

  await toggle.click();
  const panel = page.getByTestId('slime-hud-panel');
  await expect(panel).toBeVisible();

  // First sample lands after a full window of shaded frames — SwiftShader
  // paces the full tier at ~1fps, so give it room.
  const surface = page.getByTestId('slime-hud-surface');
  await expect(surface).toContainText('surface 0.400', { timeout: 90_000 });
  await expect(surface).toContainText('pinned');

  // The buffer line carries real pixels and a cadence once frames flow.
  await expect(page.getByTestId('slime-hud-buffer')).toContainText(
    /buffer \d{2,}\u00d7\d{2,} · \d+ fps/,
    { timeout: 60_000 },
  );

  // A pinned surface never resizes; the counter must agree.
  await expect(page.getByTestId('slime-hud-resizes')).toContainText(
    'resizes 0',
  );

  await toggle.click();
  await expect(page.getByTestId('slime-hud-panel')).toHaveCount(0);
});

test('the goo HUD stays out of captures that did not ask for it', async ({
  page,
}) => {
  await openBrainTab(page, '&slimeScale=0.4');
  await expect(page.getByTestId('slime-hud-toggle')).toHaveCount(0);
  await expect(page.getByTestId('slime-hud-panel')).toHaveCount(0);
});
