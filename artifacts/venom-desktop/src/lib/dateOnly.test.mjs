import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { formatLocalDateOnly } from './dateOnly.ts';

test('formats a valid date-only value without changing its calendar day', () => {
  assert.equal(formatLocalDateOnly('2026-06-15'), 'Jun 15');
});

test('keeps malformed date-only values visible instead of throwing', () => {
  assert.equal(formatLocalDateOnly('2026-02-30'), '2026-02-30');
  assert.equal(formatLocalDateOnly('not-a-date'), 'not-a-date');
});

test('keeps June 15 in a time zone west of UTC', () => {
  const moduleUrl = new URL('./dateOnly.ts', import.meta.url).href;
  const source = `
    const { formatLocalDateOnly } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(formatLocalDateOnly('2026-06-15'));
  `;
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', source],
    {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'America/Los_Angeles' },
    },
  );

  assert.equal(output, 'Jun 15');
});