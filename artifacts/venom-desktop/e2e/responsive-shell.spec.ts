import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Responsive regression for the mobile-first shell.
 *
 * The redesign relies on behaviours that are invisible to unit tests: the
 * drawer's focus handoff, safe-area padding, panels that scroll internally
 * instead of scrolling the document, and route layouts that reflow between
 * phone and desktop widths. Everything here is asserted in a real browser at
 * both widths, plus a reduced-motion pass.
 *
 * Navigation behaviour that is the same at every width (which link leads
 * where, thread switching) lives in workspace-flow.spec.ts; this file only
 * asserts what changes with the viewport.
 */

const PHONE = { width: 390, height: 667 };
/**
 * A phone with the software keyboard open: iOS/Android shrink the visual
 * viewport to roughly this height, which is when internal scrolling has to
 * work or content becomes unreachable.
 */
const PHONE_WITH_KEYBOARD = { width: 390, height: 420 };
/** A full-height notched phone, the only shape that reports safe-area insets. */
const NOTCHED_PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
/** A large desktop, where fixed-width panels have room to spare. */
const WIDE_DESKTOP = { width: 1512, height: 900 };

/** Notch and home-indicator insets of a modern phone, in CSS pixels. */
const SAFE_AREA = { top: 47, bottom: 34, left: 0, right: 0 };

/** Minimum tap target for in-page actions, per the accessibility baseline. */
const MIN_TOUCH_TARGET = 44;
/**
 * The shell's own rows (nav links, header icon buttons) are laid out on a 40px
 * grid, so they are held to that instead of the 44px in-page rule.
 */
const MIN_SHELL_TARGET = 40;

/** Drawer destinations, in the order the shell renders them. */
const NAV_LABELS = [
  'Chat',
  'Feed',
  'Brain',
  'To-Do',
  'Apps',
  'SOPs',
  'Notifications',
];

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function boxOf(locator: Locator, name: string) {
  const box = await locator.boundingBox();
  expect(box, `${name} should be laid out`).not.toBeNull();
  return box!;
}

async function expectTouchTarget(
  locator: Locator,
  name: string,
  minimum = MIN_TOUCH_TARGET,
) {
  const box = await boxOf(locator, name);
  expect(Math.round(box.width), `${name} width`).toBeGreaterThanOrEqual(
    minimum,
  );
  expect(Math.round(box.height), `${name} height`).toBeGreaterThanOrEqual(
    minimum,
  );
}

/**
 * Chromium resolves `env(safe-area-inset-*)` to 0 unless the emulated device
 * reports insets, so the notch has to be faked over CDP for the padding rules
 * to have any observable effect.
 */
async function emulateSafeAreaInsets(page: Page, insets: typeof SAFE_AREA) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setSafeAreaInsetsOverride', { insets });
}

type ScrollState = {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * Finds the nearest ancestor of `anchor` (itself included) that overflows on
 * the given axis, optionally scrolls it, and reports its metrics. Locating the
 * scroll container this way keeps the assertions tied to observable layout
 * rather than to class names or test ids.
 */
async function scrollOwner(
  anchor: Locator,
  axis: 'x' | 'y',
  delta = 0,
): Promise<ScrollState | null> {
  return anchor.evaluate(
    (element, options) => {
      let node: HTMLElement | null = element as HTMLElement;
      while (node) {
        const style = getComputedStyle(node);
        const overflow =
          options.axis === 'x' ? style.overflowX : style.overflowY;
        const scrollable = overflow === 'auto' || overflow === 'scroll';
        const overflows =
          options.axis === 'x'
            ? node.scrollWidth > node.clientWidth + 1
            : node.scrollHeight > node.clientHeight + 1;
        if (scrollable && overflows) {
          if (options.delta !== 0) {
            // `behavior: instant` overrides `scroll-smooth`, so the metrics
            // below are the settled ones rather than a mid-animation frame.
            node.scrollTo(
              options.axis === 'x'
                ? { left: node.scrollLeft + options.delta, behavior: 'instant' }
                : { top: node.scrollTop + options.delta, behavior: 'instant' },
            );
          }
          return {
            scrollLeft: node.scrollLeft,
            scrollTop: node.scrollTop,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
          };
        }
        node = node.parentElement;
      }
      return null;
    },
    { axis, delta },
  );
}

/** How far the document itself can scroll; the shell should keep this at 0. */
async function documentOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return {
      vertical: root.scrollHeight - root.clientHeight,
      horizontal: root.scrollWidth - root.clientWidth,
    };
  });
}

function drawerTrigger(page: Page) {
  return page.getByRole('button', { name: 'Open navigation' });
}

function drawer(page: Page) {
  return page.getByRole('dialog', { name: 'Navigation' });
}

async function openDrawer(page: Page) {
  await drawerTrigger(page).click();
  await expect(drawer(page)).toBeVisible();
  return drawer(page);
}

/** Opens a Brain node's details panel. */
async function openBrainDetails(page: Page, label: string) {
  await page.goto('/workspace/brain?brainFixture=dense');
  const map = page.getByRole('region', { name: /Knowledge map with \d+ nodes/ });
  await expect(map).toBeVisible();
  // Filtering first keeps the click off overlapping nodes.
  await page.getByLabel('Search map').fill(label);
  await map.getByRole('button', { name: `Node: ${label}`, exact: true }).click();
  // Named explicitly: the desktop sidebar is a complementary region too.
  const panel = brainDetails(page, label);
  await expect(panel).toBeVisible();
  await expect(page.getByRole('heading', { name: label })).toBeVisible();
  return panel;
}

/** The Brain details panel, which takes its name from the selected node. */
function brainDetails(page: Page, label: string) {
  return page.getByRole('complementary', { name: label });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone width
// ─────────────────────────────────────────────────────────────────────────────

test.describe('phone width', () => {
  test.use({ viewport: PHONE });

  test('opens the drawer, closes it on Escape, and returns focus to the trigger', async ({
    page,
  }) => {
    await page.goto('/workspace/chat');

    const trigger = drawerTrigger(page);
    await expectTouchTarget(trigger, 'drawer trigger', MIN_SHELL_TARGET);

    const panel = await openDrawer(page);
    const panelBox = await boxOf(panel, 'drawer');
    // The drawer is a partial-width sheet, so the page stays visible behind it.
    // Round like the height check below: the sheet's entry transform can
    // report float32-epsilon overshoot (e.g. 320.000015) on an exactly-320px
    // panel, which is measurement noise, not layout drift.
    expect(Math.round(panelBox.width)).toBeLessThanOrEqual(320);
    expect(Math.round(panelBox.width)).toBeLessThan(PHONE.width);
    expect(Math.round(panelBox.height)).toBe(PHONE.height);

    // Every drawer route is a comfortable touch target.
    for (const label of NAV_LABELS) {
      await expectTouchTarget(
        panel.getByRole('link', { name: label, exact: true }),
        `${label} nav item`,
        MIN_SHELL_TARGET,
      );
    }

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    // The shell restores focus after the close animation instead of dropping
    // it on <body>, so the next Tab continues from the trigger.
    await expect(trigger).toBeFocused();
  });

  test('activates routes from the keyboard and hands focus back to the trigger', async ({
    page,
  }) => {
    await page.goto('/workspace/chat');

    const trigger = drawerTrigger(page);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const panel = await drawer(page);
    await expect(panel).toBeVisible();

    // Keyboard activation of a drawer route navigates and closes the sheet.
    const brain = panel.getByRole('link', { name: 'Brain', exact: true });
    await brain.focus();
    await expect(brain).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/workspace\/brain$/);
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();

    // The global route shortcuts still work with the drawer closed.
    await page.keyboard.press('Alt+4');
    await expect(page).toHaveURL(/\/workspace\/tasks$/);
    await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();

    await page.keyboard.press('Alt+1');
    await expect(page).toHaveURL(/\/workspace\/chat$/);
  });

  test('keeps the header, drawer, and composer clear of the device safe areas', async ({
    page,
  }) => {
    /**
     * The same layout is measured with and without insets: every safe-area
     * rule in the shell should shift its element by exactly the emulated
     * inset. Comparing two runs keeps the assertions about the safe areas
     * themselves rather than about the surrounding paddings, which are free to
     * change. Insets only ever appear on a full-height notched device, so the
     * measurements use that viewport.
     */
    await page.setViewportSize(NOTCHED_PHONE);
    // The shell honors prefers-reduced-motion, so this pins mount animations
    // off — a one-shot box read must not race an easing curve under suite
    // load, where a mid-flight measurement skews the shift by a few pixels.
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const measure = async () => {
      // Late font swaps also nudge layout; wait for them before reading boxes.
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const header = await boxOf(page.getByRole('banner'), 'header');
      const trigger = await boxOf(drawerTrigger(page), 'drawer trigger');
      const send = await boxOf(
        page.getByRole('button', { name: 'Send message' }),
        'send button',
      );

      const panel = await openDrawer(page);
      const newChat = await boxOf(
        panel.getByRole('button', { name: 'New chat', exact: true }),
        'drawer new chat button',
      );
      const signOut = await boxOf(
        panel.getByRole('button', { name: 'Sign out' }),
        'sign out button',
      );
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();

      return {
        headerHeight: header.height,
        triggerTop: trigger.y,
        composerGap: NOTCHED_PHONE.height - (send.y + send.height),
        drawerHeaderTop: newChat.y,
        drawerFooterGap: NOTCHED_PHONE.height - (signOut.y + signOut.height),
      };
    };

    await page.goto('/workspace/chat');
    await expect(page.getByLabel('Message Venom')).toBeVisible();
    const flat = await measure();

    await emulateSafeAreaInsets(page, SAFE_AREA);
    await page.reload();
    await expect(page.getByLabel('Message Venom')).toBeVisible();
    const inset = await measure();

    const shift = (after: number, before: number) => Math.round(after - before);

    // Header grows by the top inset, so its controls clear the notch.
    expect(shift(inset.headerHeight, flat.headerHeight)).toBe(SAFE_AREA.top);
    expect(shift(inset.triggerTop, flat.triggerTop)).toBe(SAFE_AREA.top);

    // The composer lifts off the home indicator instead of sitting under it.
    expect(shift(inset.composerGap, flat.composerGap)).toBe(SAFE_AREA.bottom);

    // The drawer pads both ends: its top controls clear the notch and its
    // account row stays above the home indicator.
    expect(shift(inset.drawerHeaderTop, flat.drawerHeaderTop)).toBe(
      SAFE_AREA.top,
    );
    expect(shift(inset.drawerFooterGap, flat.drawerFooterGap)).toBe(
      SAFE_AREA.bottom,
    );
  });

  test('keeps the chat composer reachable while the transcript scrolls internally', async ({
    page,
  }) => {
    await page.goto('/workspace/chat');

    const composer = page.getByLabel('Message Venom');
    await expect(composer).toBeVisible();
    await expect(composer).toBeInViewport();
    await expectTouchTarget(composer, 'chat composer');
    // The send icon sits inside the 44px composer row, so it is held to the
    // smaller icon-button size the composer is designed around.
    await expectTouchTarget(
      page.getByRole('button', { name: 'Send message' }),
      'send button',
      36,
    );

    // Typing must not push the composer off-screen.
    await composer.fill('Regression check for the mobile composer');
    await expect(composer).toBeInViewport();
    const sendBox = await boxOf(
      page.getByRole('button', { name: 'Send message' }),
      'send button',
    );
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(PHONE.height);

    // The shell owns its own height: the document never scrolls.
    const overflow = await documentOverflow(page);
    expect(overflow.vertical).toBeLessThanOrEqual(1);
    expect(overflow.horizontal).toBeLessThanOrEqual(1);
  });

  test('opens Brain details as a bottom sheet that scrolls inside itself', async ({
    page,
  }) => {
    const panel = await openBrainDetails(page, 'Product Context');

    // Bottom sheet: full width, pinned to the bottom, partial height. The
    // panel slides up on open, so the resting position is polled.
    await expect
      .poll(async () => {
        const box = await boxOf(panel, 'details panel');
        return Math.round(box.y + box.height);
      })
      .toBe(PHONE.height);

    const panelBox = await boxOf(panel, 'details panel');
    expect(Math.round(panelBox.x)).toBe(0);
    expect(Math.round(panelBox.width)).toBe(PHONE.width);
    expect(panelBox.height).toBeLessThan(PHONE.height * 0.8);

    // The footer action stays pinned while the body scrolls.
    const deleteConcept = panel.getByRole('button', { name: 'Delete Concept' });
    await expect(deleteConcept).toBeInViewport();

    const summary = panel.getByRole('heading', { name: 'Data Profile' });
    const initial = await scrollOwner(summary, 'y');
    expect(initial, 'details body should scroll internally').not.toBeNull();

    const scrolled = await scrollOwner(summary, 'y', 400);
    expect(scrolled!.scrollTop).toBeGreaterThan(initial!.scrollTop);
    await expect(deleteConcept).toBeInViewport();
    // Scrolling the sheet never spills over into the document.
    expect((await documentOverflow(page)).vertical).toBeLessThanOrEqual(1);

    await panel.getByLabel('Close details').click();
    await expect(brainDetails(page, 'Product Context')).toHaveCount(0);
  });

  test('scrolls the To-Do board horizontally and keeps card actions tappable', async ({
    page,
  }) => {
    await page.goto('/workspace/tasks');
    await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();

    const pending = page.getByRole('heading', { name: 'Pending', exact: true });
    const executing = page.getByRole('heading', {
      name: 'Executing',
      exact: true,
    });

    // One column at a time on a phone; the rest are a swipe away.
    await expect(pending).toBeInViewport();
    await expect(executing).not.toBeInViewport();

    const initial = await scrollOwner(pending, 'x');
    expect(initial, 'task board should scroll horizontally').not.toBeNull();
    expect(initial!.scrollWidth).toBeGreaterThan(initial!.clientWidth);

    const scrolled = await scrollOwner(pending, 'x', initial!.clientWidth);
    expect(scrolled!.scrollLeft).toBeGreaterThan(initial!.scrollLeft);
    await expect(executing).toBeInViewport();

    // Card actions stay visible at phone widths, where there is no hover to
    // reveal them, and keep a 44px target.
    const card = page.getByRole('listitem').first();
    await expect(card).toBeVisible();
    for (const action of [/^Move ".+" to /, /^Delete ".+"$/]) {
      const button = card.getByRole('button', { name: action }).first();
      await expect(button).toBeVisible();
      await expectTouchTarget(button, `card action ${action}`);
    }

    // Horizontal movement belongs to the board, not the page.
    expect((await documentOverflow(page)).horizontal).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Landing page with the keyboard open
// ─────────────────────────────────────────────────────────────────────────────

test.describe('landing page on a short phone viewport', () => {
  test.use({ viewport: PHONE_WITH_KEYBOARD });

  test('keeps the compact composer reachable without page overflow', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'What are you working on?' }),
    ).toBeVisible();

    const prompt = page.getByLabel('Ask Venom');
    await expectTouchTarget(prompt, 'landing prompt');

    // The reference landing screen is deliberately sparse. With no promotional
    // footnote or suggestion cards, the keyboard-height viewport must simply
    // fit in place rather than depending on an internal scrolling region.
    await expect(prompt).toBeInViewport();
    const overflow = await documentOverflow(page);
    expect(overflow.vertical).toBeLessThanOrEqual(1);
    expect(overflow.horizontal).toBeLessThanOrEqual(1);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeInViewport();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Desktop width
// ─────────────────────────────────────────────────────────────────────────────

test.describe('desktop width', () => {
  test.use({ viewport: DESKTOP });

  test('replaces the drawer with a persistent sidebar', async ({ page }) => {
    await page.goto('/workspace/chat');

    const sidebar = page.getByTestId('sidebar-desktop');
    await expect(sidebar).toBeVisible();
    // Wide screens show the navigation permanently, so the drawer and its
    // trigger are not part of the layout at all.
    await expect(drawerTrigger(page)).toBeHidden();
    await expect(drawer(page)).toHaveCount(0);

    const sidebarBox = await boxOf(sidebar, 'sidebar');
    expect(Math.round(sidebarBox.x)).toBe(0);
    expect(Math.round(sidebarBox.height)).toBe(DESKTOP.height);
    // A fixed rail rather than a share of the viewport.
    expect(sidebarBox.width).toBeLessThan(DESKTOP.width / 3);

    for (const label of NAV_LABELS) {
      await expect(
        sidebar.getByRole('link', { name: label, exact: true }),
      ).toBeInViewport();
    }

    // The conversation column keeps the remaining width and the composer.
    const composer = page.getByLabel('Message Venom');
    await expect(composer).toBeInViewport();
    const composerBox = await boxOf(composer, 'chat composer');
    expect(composerBox.x).toBeGreaterThanOrEqual(sidebarBox.width);

    // Route shortcuts stay available without a drawer to open.
    await page.keyboard.press('Alt+3');
    await expect(page).toHaveURL(/\/workspace\/brain$/);
    await expect(sidebar).toBeVisible();
  });

  test('keeps the sidebar chat list scrolling inside its own rail', async ({
    page,
  }) => {
    await page.goto('/workspace/chat');

    const sidebar = page.getByTestId('sidebar-desktop');
    const signOut = sidebar.getByRole('button', { name: 'Sign out' });
    // The account row is pinned: it stays on screen however long the chat
    // list grows, because only the list scrolls.
    await expect(signOut).toBeInViewport();
    await expect(sidebar.getByTestId('list-conversations-desktop')).toHaveCSS(
      'overflow-y',
      'auto',
    );
    expect((await documentOverflow(page)).vertical).toBeLessThanOrEqual(1);
  });

  test('docks Brain details to a side panel instead of a bottom sheet', async ({
    page,
  }) => {
    const panel = await openBrainDetails(page, 'Product Context');
    const panelBox = await boxOf(panel, 'details panel');

    expect(panelBox.x).toBeGreaterThan(DESKTOP.width / 2);
    expect(Math.round(panelBox.width)).toBe(420);
    // Inset from the viewport edges rather than pinned to the bottom.
    expect(panelBox.y).toBeGreaterThan(0);
    expect(panelBox.y + panelBox.height).toBeLessThan(DESKTOP.height);

    await panel.getByLabel('Close details').click();
    await expect(brainDetails(page, 'Product Context')).toHaveCount(0);
  });

  test('lays the To-Do columns side by side and keeps overflow inside the board', async ({
    page,
  }) => {
    await page.goto('/workspace/tasks');
    await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();

    // Side by side rather than the phone's one-column-per-swipe board.
    for (const column of ['Pending', 'Executing', 'Resolved']) {
      await expect(
        page.getByRole('heading', { name: column, exact: true }),
      ).toBeInViewport();
    }
    expect((await documentOverflow(page)).horizontal).toBeLessThanOrEqual(1);

    // The fixed-width columns still exceed a 1280px laptop once the sidebar
    // takes its rail, so the remainder has to stay inside the board.
    const pending = page.getByRole('heading', { name: 'Pending', exact: true });
    const board = await scrollOwner(pending, 'x');
    expect(board, 'board should own its horizontal overflow').not.toBeNull();

    // Given room, the whole board fits with nothing left to scroll to.
    await page.setViewportSize(WIDE_DESKTOP);
    await expect(
      page.getByRole('heading', { name: 'Resolved', exact: true }),
    ).toBeInViewport();
    const wide = await scrollOwner(pending, 'x');
    const hidden = wide ? wide.scrollWidth - wide.clientWidth : 0;
    expect(hidden, 'board content hidden behind a swipe').toBeLessThanOrEqual(
      1,
    );
    expect((await documentOverflow(page)).horizontal).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reduced motion
// ─────────────────────────────────────────────────────────────────────────────

test.describe('reduced motion on a phone', () => {
  test.use({ viewport: PHONE });

  test.beforeEach(async ({ page }) => {
    // Emulated on the page rather than through `test.use`, which this
    // Playwright version ignores for this option.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('keeps the drawer, routing, and detail panels usable', async ({
    page,
  }) => {
    await page.goto('/workspace/chat');
    await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

    // Guards the coverage claim: without the emulation this would be a second
    // copy of the default-motion pass.
    expect(
      await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
      'reduced motion should be emulated',
    ).toBe(true);

    const trigger = drawerTrigger(page);
    const panel = await openDrawer(page);
    await panel.getByRole('link', { name: 'To-Do', exact: true }).click();
    await expect(page).toHaveURL(/\/workspace\/tasks$/);
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();

    // Panels that animate in must still settle into place and close.
    const details = await openBrainDetails(page, 'Product Context');
    await expect(
      details.getByRole('button', { name: 'Delete Concept' }),
    ).toBeInViewport();
    await details.getByLabel('Close details').click();
    await expect(brainDetails(page, 'Product Context')).toHaveCount(0);

    // Reopening the drawer after animations are suppressed still traps and
    // returns focus correctly.
    const reopened = await openDrawer(page);
    await page.keyboard.press('Escape');
    await expect(reopened).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
