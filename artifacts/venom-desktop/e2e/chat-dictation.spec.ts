import { expect, test, type Page } from '@playwright/test';

/**
 * Composer dictation: the mic button records one take, the transcription
 * endpoint turns it into text, and the words land in the input box ready
 * to edit. Media APIs are stubbed — headless browsers have no microphone —
 * so these tests own the state machine and the wiring, not audio quality.
 */

const DESKTOP = { width: 1280, height: 860 };

async function mockModels(page: Page) {
  await page.route('**/api/venom/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'gpt-5',
          provider: 'openai',
          name: 'Test Model',
          family: 'GPT',
          summary: 'Model used by browser tests.',
          available: true,
          availabilityText: 'Ready',
        },
      ]),
    });
  });
}

async function openChat(page: Page) {
  await mockModels(page);
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

/** Installs a working fake recorder pipeline before any app code runs. */
async function stubWorkingMicrophone(page: Page) {
  await page.addInitScript(() => {
    class FakeRecorder {
      static isTypeSupported() {
        return true;
      }
      stream: unknown;
      mimeType: string;
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(stream: unknown, options?: { mimeType?: string }) {
        this.stream = stream;
        this.mimeType = options?.mimeType ?? 'audio/webm';
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        const data = new Blob([new Uint8Array([79, 103, 103, 83])], {
          type: 'audio/webm',
        });
        this.ondataavailable?.({ data });
        this.onstop?.();
      }
    }
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder =
      FakeRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    });
  });
}

test.describe('composer dictation', () => {
  test.use({ viewport: DESKTOP });

  test('a mic take is transcribed into the input box, appended to typed text', async ({
    page,
  }) => {
    await stubWorkingMicrophone(page);

    const transcribeBodies: Array<{ audioBase64?: string }> = [];
    await page.route('**/api/venom/voice/transcribe', async (route) => {
      transcribeBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'dictated words' }),
      });
    });

    await openChat(page);

    // Typed text first: dictation must append, never replace.
    await page.getByTestId('input-message').fill('Note:');

    const mic = page.getByTestId('button-dictate');
    await mic.click();

    // Recording state is visible and honest.
    await expect(page.getByTestId('dictation-status')).toContainText(
      'Listening',
    );
    await expect(mic).toHaveAttribute('aria-pressed', 'true');

    await mic.click();

    // The transcript lands appended and editable; the indicator clears.
    await expect(page.getByTestId('input-message')).toHaveValue(
      'Note: dictated words',
    );
    await expect(page.getByTestId('dictation-status')).toHaveCount(0);
    await expect(mic).toHaveAttribute('aria-pressed', 'false');

    // The request carried base64 audio (the server sniffs the container).
    expect(transcribeBodies.length).toBe(1);
    expect(typeof transcribeBodies[0].audioBase64).toBe('string');
    expect(transcribeBodies[0].audioBase64!.length).toBeGreaterThan(0);
  });

  test('a declined microphone shows guidance instead of recording', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      class FakeRecorder {
        static isTypeSupported() {
          return true;
        }
        start() {}
        stop() {}
        state = 'inactive';
      }
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder =
        FakeRecorder;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            throw new DOMException('denied', 'NotAllowedError');
          },
        },
      });
    });

    await openChat(page);

    await page.getByTestId('button-dictate').click();

    // exact: true pins the toast title; the toaster's transient aria-live
    // announcement briefly concatenates title+description and would trip
    // strict mode otherwise.
    await expect(
      page.getByText('Microphone access was declined.', { exact: true }),
    ).toBeVisible();
    // No phantom recording state.
    await expect(page.getByTestId('dictation-status')).toHaveCount(0);
  });

  test('navigating away while the permission prompt is open never leaves the mic hot', async ({
    page,
  }) => {
    // getUserMedia stays pending until the test grants it — exactly like a
    // permission prompt the user has not answered yet.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __micTrackStops: number;
        __recorders: Array<{ state: string }>;
        __grantMic?: () => void;
        MediaRecorder: unknown;
      };
      w.__micTrackStops = 0;
      w.__recorders = [];
      class FakeRecorder {
        static isTypeSupported() {
          return true;
        }
        state = 'inactive';
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        constructor() {
          w.__recorders.push(this);
        }
        start() {
          this.state = 'recording';
        }
        stop() {
          this.state = 'inactive';
          this.onstop?.();
        }
      }
      w.MediaRecorder = FakeRecorder;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () =>
            new Promise((resolve) => {
              w.__grantMic = () =>
                resolve({
                  getTracks: () => [
                    {
                      stop() {
                        w.__micTrackStops += 1;
                      },
                    },
                  ],
                });
            }),
        },
      });
    });

    await openChat(page);

    await page.getByTestId('button-dictate').click();
    // Prompt pending: nothing records yet, no recording UI.
    await expect(page.getByTestId('dictation-status')).toHaveCount(0);

    // Leave the chat page before answering the prompt…
    await page.getByTestId('link-nav-brain').click();
    await expect(page.getByTestId('form-composer')).toHaveCount(0);

    // …then grant the microphone to the page that no longer exists.
    await page.evaluate(() => {
      (window as unknown as { __grantMic?: () => void }).__grantMic?.();
    });

    // The late-arriving stream must be released immediately: every track
    // stopped, every recorder back to inactive — no 60-second hot mic.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __micTrackStops: number }).__micTrackStops,
        ),
      )
      .toBeGreaterThan(0);
    const recorderStates = await page.evaluate(() =>
      (
        window as unknown as { __recorders: Array<{ state: string }> }
      ).__recorders.map((recorder) => recorder.state),
    );
    expect(recorderStates.every((state) => state === 'inactive')).toBe(true);
  });

  test('a failed transcription reports and returns the composer to idle', async ({
    page,
  }) => {
    await stubWorkingMicrophone(page);
    await page.route('**/api/venom/voice/transcribe', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Transcription is unavailable.' }),
      });
    });

    await openChat(page);

    const mic = page.getByTestId('button-dictate');
    await mic.click();
    await expect(page.getByTestId('dictation-status')).toContainText(
      'Listening',
    );
    await mic.click();

    await expect(
      page.getByText("That didn't make it into text.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('dictation-status')).toHaveCount(0);
    // The input keeps whatever was typed — nothing is lost to the failure.
    await expect(page.getByTestId('input-message')).toHaveValue('');
    // The mic is ready for another take.
    await expect(mic).toBeEnabled();
  });
});
