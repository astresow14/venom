import { expect, test, type Page } from '@playwright/test';
import {
  mockKnowledgeExtraction,
  mockStagedChatStream,
  sseBody,
  STUB_MODEL,
} from './support/chat-stream';

/**
 * Chat file exchange: uploads riding a message, the live document-writing
 * card, the delivered file's download, and the render-failure path that
 * must never cost the user the streamed answer.
 */

const DESKTOP = { width: 1280, height: 860 };

/** The e2e dev server serves the UI only, so the model list is stubbed. */
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

/** Stubs the three-step upload handshake for one file. */
async function mockUploadHandshake(
  page: Page,
  fileId: string,
  name: string,
  contentType = 'text/plain',
) {
  await page.route('**/api/venom/files/uploads', async (route) => {
    const body = route.request().postDataJSON() as {
      name: string;
      contentType: string;
      size: number;
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        file: {
          id: fileId,
          name: body.name,
          contentType: body.contentType,
          size: body.size,
          kind: 'upload',
          status: 'pending',
          textExtracted: false,
          createdAt: Date.now(),
        },
        uploadUrl: `/__test-upload/${fileId}`,
        maxBytes: 10 * 1024 * 1024,
      }),
    });
  });
  await page.route('**/__test-upload/*', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route('**/api/venom/files/uploads/*/complete', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: fileId,
        name,
        contentType,
        size: 26,
        kind: 'upload',
        status: 'ready',
        textExtracted: false,
        createdAt: Date.now(),
      }),
    });
  });
}

/** A real, decodable 1×1 PNG so the canvas thumbnail pipeline runs. */
const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Builds a File in the page and returns a DataTransfer carrying it. */
const dataTransferWithPng = (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const file = new File([bytes], 'pixel.png', { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  return transfer;
};

test.describe('chat file exchange', () => {
  test.use({ viewport: DESKTOP });

  test('an uploaded file rides the message and its id reaches the wire', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockUploadHandshake(page, 'file-notes-1', 'notes.txt');

    let respondBody: {
      messages?: Array<{ role: string; attachmentIds?: string[] }>;
    } | null = null;
    await page.route('**/api/venom/respond', async (route) => {
      respondBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(['I read the file.']),
      });
    });

    await openChat(page);

    await page
      .getByTestId('input-chat-file')
      .setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('remember: ship the exchange'),
      });

    // The chip settles into its ready state once the handshake finishes.
    await expect(page.getByTestId('chip-pending-file-ready')).toBeVisible();
    await expect(page.getByTestId('chip-pending-file-ready')).toContainText(
      'notes.txt',
    );

    // No text typed: the attachment alone makes the message sendable.
    await page.getByTestId('button-send').click();

    await expect(page.getByTestId('chip-message-attachment')).toContainText(
      'notes.txt',
    );
    // The composer starts clean for the next message.
    await expect(page.getByTestId('row-composer-attachments')).toHaveCount(0);
    await expect(page.getByTestId('message-assistant')).toContainText(
      'I read the file.',
    );

    expect(respondBody).not.toBeNull();
    const lastMessage = respondBody!.messages?.at(-1);
    expect(lastMessage?.role).toBe('user');
    expect(lastMessage?.attachmentIds).toEqual(['file-notes-1']);
  });

  test('an attached image shows a thumbnail chip and a bubble preview', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockUploadHandshake(page, 'file-img-1', 'pixel.png', 'image/png');

    let respondBody: {
      messages?: Array<{ role: string; attachmentIds?: string[] }>;
    } | null = null;
    await page.route('**/api/venom/respond', async (route) => {
      respondBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody(['A single red pixel.']),
      });
    });

    await openChat(page);

    await page.getByTestId('input-chat-file').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: PNG_PIXEL,
    });

    // The chip carries a real rendered thumbnail, not a generic icon.
    await expect(page.getByTestId('chip-pending-file-ready')).toBeVisible();
    await expect(page.getByTestId('img-pending-thumbnail')).toBeVisible();

    await page.getByTestId('button-send').click();

    // The sent bubble shows the image preview with its name.
    await expect(page.getByTestId('img-message-attachment')).toBeVisible();
    await expect(page.getByTestId('message-user')).toContainText('pixel.png');
    await expect(page.getByTestId('message-assistant')).toContainText(
      'A single red pixel.',
    );

    expect(respondBody).not.toBeNull();
    expect(respondBody!.messages?.at(-1)?.attachmentIds).toEqual([
      'file-img-1',
    ]);
  });

  test('pasting an image from the clipboard queues it as an attachment', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockUploadHandshake(page, 'file-img-2', 'pixel.png', 'image/png');

    await openChat(page);

    await page.getByTestId('input-message').click();
    await page.evaluate(
      ([base64]) => {
        const bytes = Uint8Array.from(atob(base64), (char) =>
          char.charCodeAt(0),
        );
        const file = new File([bytes], 'pixel.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const target = document.querySelector(
          '[data-testid="input-message"]',
        )!;
        target.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [PNG_PIXEL.toString('base64')],
    );

    await expect(page.getByTestId('img-pending-thumbnail')).toBeVisible();
    await expect(page.getByTestId('chip-pending-file-ready')).toBeVisible();
  });

  test('dragging files over the chat shows the overlay and drop attaches', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockUploadHandshake(page, 'file-img-3', 'pixel.png', 'image/png');

    await openChat(page);

    const base64 = PNG_PIXEL.toString('base64');
    await page.evaluate(
      ([data]) => {
        const bytes = Uint8Array.from(atob(data), (char) =>
          char.charCodeAt(0),
        );
        const file = new File([bytes], 'pixel.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const target = document.querySelector(
          '[data-testid="form-composer"]',
        )!;
        target.dispatchEvent(
          new DragEvent('dragenter', {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [base64],
    );

    await expect(page.getByTestId('overlay-drop-files')).toBeVisible();

    await page.evaluate(
      ([data]) => {
        const bytes = Uint8Array.from(atob(data), (char) =>
          char.charCodeAt(0),
        );
        const file = new File([bytes], 'pixel.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const target = document.querySelector(
          '[data-testid="form-composer"]',
        )!;
        target.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [base64],
    );

    await expect(page.getByTestId('overlay-drop-files')).toHaveCount(0);
    await expect(page.getByTestId('chip-pending-file-ready')).toBeVisible();
    await expect(page.getByTestId('img-pending-thumbnail')).toBeVisible();
  });

  test('an unsupported drop is rejected with the reason on the chip', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);

    await openChat(page);

    await page.evaluate(() => {
      const file = new File(['MZ'], 'virus.exe', {
        type: 'application/octet-stream',
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = document.querySelector(
        '[data-testid="form-composer"]',
      )!;
      target.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const errorChip = page.getByTestId('chip-pending-file-error');
    await expect(errorChip).toBeVisible();
    // The reason rides the chip's tooltip; the chip itself names the file.
    await expect(errorChip).toHaveAttribute('title', /Venom reads/);
    await expect(errorChip).toContainText('virus.exe');
  });

  test('a generated document shows its writing card, then downloads', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockStagedChatStream(page, [
      [
        [
          50,
          {
            ...STUB_MODEL,
            filePlan: { format: 'pdf', title: 'Q3 Report', switchedFrom: 'verify' },
          },
        ],
        [100, { content: 'Summary: the quarter held steady.' }],
        [150, { fileProgress: { chars: 2400 } }],
        // A long gap keeps the writing card on screen for the assertions.
        [900, { fileProgress: { chars: 5200 } }],
        [
          250,
          {
            file: {
              id: 'file-gen-1',
              name: 'venom-q3-report.pdf',
              contentType: 'application/pdf',
              size: 4096,
              kind: 'generated',
            },
          },
        ],
        [100, { done: true }],
      ],
    ]);
    await page.route('**/api/venom/files/file-gen-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.7 test bytes'),
      });
    });

    await openChat(page);

    const composer = page.getByTestId('input-message');
    await composer.fill('Turn this into a PDF report');
    await composer.press('Enter');

    // Mid-stream: the writing card names the document and announces that
    // the requested Verify round stepped aside for a single author.
    const writing = page.getByTestId('card-file-writing');
    await expect(writing).toBeVisible();
    await expect(writing).toContainText('Writing Q3 Report');
    await expect(writing).toContainText('2,400 characters');
    await expect(page.getByTestId('text-file-mode-note')).toContainText(
      'Verify stepped aside',
    );

    // Delivery: the card replaces the writing state and survives the turn.
    const delivery = page.getByTestId('card-file-delivery');
    await expect(delivery).toBeVisible();
    await expect(delivery).toContainText('venom-q3-report.pdf');
    await expect(page.getByTestId('card-file-writing')).toHaveCount(0);
    await expect(page.getByTestId('message-assistant')).toContainText(
      'the quarter held steady',
    );

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('button-file-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('venom-q3-report.pdf');
  });

  test('a failed render keeps the streamed answer and says so', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockStagedChatStream(page, [
      [
        [
          50,
          { ...STUB_MODEL, filePlan: { format: 'pdf', title: 'Summary' } },
        ],
        [100, { content: 'Here is the summary ' }],
        [100, { content: 'in chat form.' }],
        [
          200,
          {
            error: 'The document could not be rendered.',
            code: 'file_render_failed',
            retryable: true,
          },
        ],
        [100, { done: true }],
      ],
    ]);

    await openChat(page);

    const composer = page.getByTestId('input-message');
    await composer.fill('Write it up as a PDF');
    await composer.press('Enter');

    // The answer persists as a normal sent message…
    await expect(page.getByTestId('message-assistant')).toContainText(
      'Here is the summary in chat form.',
    );
    // …with no stream error and no phantom file card.
    await expect(page.getByTestId('alert-stream-error')).toHaveCount(0);
    await expect(page.getByTestId('card-file-delivery')).toHaveCount(0);
    await expect(page.getByTestId('card-file-writing')).toHaveCount(0);
    // The failure is announced without touching the transcript. exact: true
    // pins the toast title; the toaster's transient aria-live announcement
    // briefly mirrors title+description as one concatenated string and would
    // otherwise trip strict mode while it is mounted.
    await expect(
      page.getByText("The document couldn't be created", { exact: true }),
    ).toBeVisible();
  });
});
