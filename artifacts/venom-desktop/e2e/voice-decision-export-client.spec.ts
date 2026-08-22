import { expect, test } from '@playwright/test';

// Generated-client-level contract check for the voice-decision JSONL export.
//
// The OpenAPI contract declares the export as text/plain so the generated
// `exportVenomVoiceDecisions` returns `Promise<string>`, and the shared fetch
// layer parses text/* bodies into exactly that string. If the media type ever
// drifts back to an unrecognized one (e.g. application/x-ndjson), customFetch
// would hand back a Blob while the type still promised a string — this spec
// runs the real generated function against a stubbed fetch to pin that down.
// It runs entirely in the Playwright node process; no page is involved.
import { exportVenomVoiceDecisions } from '@workspace/api-client-react';

const RECORDS = [
  {
    decidedAt: '2026-08-20T10:00:00.000Z',
    talkativeness: 'balanced',
    decision: 'silent',
    source: 'heuristic',
    windDown: false,
    outcome: 'user_followed_up',
  },
  {
    decidedAt: '2026-08-20T10:01:00.000Z',
    talkativeness: 'balanced',
    decision: 'respond',
    source: 'model',
    windDown: false,
    outcome: 'reply_completed',
  },
];
const JSONL_BODY = `${RECORDS.map((record) => JSON.stringify(record)).join('\n')}\n`;

test('generated voice-decision export resolves to the JSONL body string, as typed', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requests.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSONL_BODY, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition':
          'attachment; filename="venom-voice-decisions-2026-08-21.jsonl"',
      },
    });
  }) as typeof fetch;

  try {
    const body = await exportVenomVoiceDecisions({ windowDays: 45 });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toContain('/api/venom/voice/decisions/export?');
    expect(requests[0].url).toContain('windowDays=45');

    // A string — not a Blob, not a Response — per the generated return type.
    expect(typeof body).toBe('string');
    expect(body).toBe(JSONL_BODY);

    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(RECORDS.length);
    lines.forEach((line, i) => {
      expect(JSON.parse(line)).toEqual(RECORDS[i]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
