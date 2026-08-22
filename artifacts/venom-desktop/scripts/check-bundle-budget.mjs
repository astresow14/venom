#!/usr/bin/env node
/**
 * Critical-path JavaScript budget check for the venom-desktop app.
 *
 * Two groups of chunks are guarded:
 *
 * 1. Landing critical path — what every visitor downloads before the landing
 *    route can render: the entry `<script type="module">` plus every
 *    `<link rel="modulepreload">` in the built index.html.
 * 2. Workspace route group — what signed-in users additionally download
 *    before their first useful screen: the workspace-routes chunk plus its
 *    static import closure (walked via the `imports` arrays recorded in
 *    dist/bundle-composition.json), minus chunks already counted in group 1.
 *
 * Route code stays behind dynamic `import()`, so a single accidental static
 * import is enough to drag a whole page or library back onto the critical
 * path — or to bloat the bundle every signed-in user waits for — and the
 * only symptom is a slower app. This script makes those regressions build
 * failures instead.
 *
 * What it does:
 *   1. Parses dist/public/index.html for the critical-path chunk files.
 *   2. Walks dist/bundle-composition.json (written by the
 *      bundle-composition-report plugin in vite.config.ts) for the workspace
 *      route group.
 *   3. Measures gzip sizes (what a visitor actually downloads).
 *   4. Compares against the committed bundle-budget.json.
 *   5. On failure, diffs the chunk's module composition against the baseline
 *      so the message names what grew.
 *
 * It fails when:
 *   - a chunk not listed in the budget shows up in either group,
 *   - any budgeted chunk exceeds its gzip budget,
 *   - either group's combined gzip size exceeds its total budget.
 *
 * Shrinking is always allowed (the check suggests ratcheting the budget down).
 *
 * Usage:
 *   node scripts/check-bundle-budget.mjs            verify the current build
 *   node scripts/check-bundle-budget.mjs --update   rewrite bundle-budget.json
 *                                                   from the current build
 *
 * Run it after a production build. `pnpm run check:bundle-budget` and
 * `pnpm run update:bundle-budget` do both steps in one go.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const artifactRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const distDir = path.join(artifactRoot, 'dist', 'public');
const indexHtmlPath = path.join(distDir, 'index.html');
const reportPath = path.join(artifactRoot, 'dist', 'bundle-composition.json');
const budgetPath = path.join(artifactRoot, 'bundle-budget.json');

/** Headroom applied on top of the measured size when (re)generating budgets. */
const HEADROOM_RATIO = 0.1;
const KIB = 1024;

/**
 * The chunk name (Rollup facade name, stable across content hashes) of the
 * signed-in workspace's route module, src/routes/workspace-routes.tsx. The
 * workspace route group is its static import closure.
 */
const WORKSPACE_CHUNK_NAME = 'workspace-routes';

const updateMode = process.argv.includes('--update');

const UPDATE_HINT = [
  'If this growth is deliberate, refresh the budget with:',
  '  pnpm --filter @workspace/venom-desktop run update:bundle-budget',
  'and commit the updated bundle-budget.json.',
].join('\n');

function rel(p) {
  return path.relative(artifactRoot, p);
}

function kib(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

function delta(bytes) {
  const sign = bytes >= 0 ? '+' : '-';
  return `${sign}${kib(Math.abs(bytes))}`;
}

function roundUpToKiB(bytes) {
  return Math.ceil(bytes / KIB) * KIB;
}

function die(message) {
  console.error(message);
  process.exit(1);
}

// --------------------------------------------------------------------------
// 1. Find the critical-path chunks in the built index.html.
// --------------------------------------------------------------------------

if (!existsSync(indexHtmlPath)) {
  die(
    `Missing ${rel(indexHtmlPath)}.\n` +
      'Run the production build first (pnpm run check:bundle-budget does both).',
  );
}

const html = readFileSync(indexHtmlPath, 'utf8');

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? match[1] : undefined;
}

function urlToAssetFile(url) {
  const clean = url.split(/[?#]/)[0];
  const base = path.posix.basename(clean);
  return { fileName: `assets/${base}`, filePath: path.join(distDir, 'assets', base) };
}

const entryUrls = [];
for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
  if (/\btype\s*=\s*"module"/i.test(tag)) {
    const src = attribute(tag, 'src');
    if (src) entryUrls.push(src);
  }
}

const preloadUrls = [];
for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
  if (/\brel\s*=\s*"modulepreload"/i.test(tag)) {
    const href = attribute(tag, 'href');
    if (href) preloadUrls.push(href);
  }
}

// Guard against the parser silently going blind: legitimate shrinkage may
// remove budgeted preloads, but if the HTML still *mentions* modulepreload and
// we extracted none, the markup shape changed and this script needs updating.
if (preloadUrls.length === 0 && /modulepreload/i.test(html)) {
  die(
    `${rel(indexHtmlPath)} contains "modulepreload" but no preload URLs were ` +
      'extracted — the emitted markup shape changed.\n' +
      'Update the parsing in scripts/check-bundle-budget.mjs before trusting this check.',
  );
}

if (entryUrls.length !== 1) {
  die(
    `Expected exactly one <script type="module"> in ${rel(indexHtmlPath)}, found ${entryUrls.length}.\n` +
      'The critical-path check assumes a single entry chunk; if the app shape ' +
      'changed on purpose, update scripts/check-bundle-budget.mjs to match.',
  );
}

/** Strip Vite's 8-char content hash: "vendor-react-CSziK9lZ.js" → "vendor-react". */
function chunkLabel(fileName) {
  const base = path.posix.basename(fileName);
  const match = base.match(/^(.+)-[A-Za-z0-9_-]{8}\.js$/);
  return match ? match[1] : base.replace(/\.js$/, '');
}

const critical = [];
{
  const { fileName, filePath } = urlToAssetFile(entryUrls[0]);
  critical.push({ label: 'entry', fileName, filePath });
}
for (const url of preloadUrls) {
  const { fileName, filePath } = urlToAssetFile(url);
  critical.push({ label: chunkLabel(fileName), fileName, filePath });
}

const seen = new Map();
for (const chunk of critical) {
  if (seen.has(chunk.label)) {
    die(
      `Two critical-path chunks share the label "${chunk.label}": ` +
        `${seen.get(chunk.label)} and ${chunk.fileName}.\n` +
        'The critical-path shape changed; update bundle-budget.json (and this ' +
        'script if labels genuinely collide) deliberately.\n\n' +
        UPDATE_HINT,
    );
  }
  seen.set(chunk.label, chunk.fileName);
}

for (const chunk of critical) {
  if (!existsSync(chunk.filePath)) {
    die(
      `${rel(indexHtmlPath)} references ${chunk.fileName}, which does not exist.\n` +
        'The dist output is stale or partial — rerun the production build.',
    );
  }
  const content = readFileSync(chunk.filePath);
  chunk.rawBytes = content.length;
  chunk.gzipBytes = gzipSync(content).length;
}

const totalGzip = critical.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);

// --------------------------------------------------------------------------
// 2. Load the composition report (module-level attribution + chunk graph).
// --------------------------------------------------------------------------

/**
 * Collapse a normalized module id to what a human acts on: the npm package
 * name for dependency code, the file path for workspace code.
 */
function compositionGroup(moduleId) {
  if (moduleId.startsWith('npm:')) {
    const subpath = moduleId.slice('npm:'.length).split(/[?#]/)[0];
    const segments = subpath.split('/');
    const pkg = subpath.startsWith('@')
      ? `${segments[0]}/${segments[1]}`
      : segments[0];
    return `npm:${pkg}`;
  }
  return moduleId.split('?')[0];
}

function loadReport() {
  if (!existsSync(reportPath)) return undefined;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return undefined;
  }
}

const report = loadReport();
const reportChunksByFile = new Map(
  (report?.chunks ?? []).map((chunk) => [chunk.fileName, chunk]),
);

/**
 * label → { group → pre-minify rendered bytes } for every chunk in the list,
 * or undefined when the report does not know one of them (stale report).
 */
function compositionFor(chunkList) {
  if (!report) return undefined;
  const result = {};
  for (const chunk of chunkList) {
    const recorded = reportChunksByFile.get(chunk.fileName);
    // A report that does not know a current file is from an older build.
    if (!recorded) return undefined;
    const groups = {};
    for (const [id, bytes] of Object.entries(recorded.modules ?? {})) {
      const group = compositionGroup(id);
      groups[group] = (groups[group] ?? 0) + bytes;
    }
    result[chunk.label] = groups;
  }
  return result;
}

const composition = compositionFor(critical);

// The report is structural, not just attribution: without a fresh one the
// workspace route group below cannot even be discovered, so a missing or
// stale report is fatal instead of a degraded warning.
if (!composition) {
  die(
    `${rel(reportPath)} is missing or does not match the current dist output.\n` +
      'It is required to attribute growth to modules and to discover the\n' +
      'workspace route group (found by walking static chunk imports).\n' +
      'Rerun the production build (pnpm run check:bundle-budget does both).',
  );
}

{
  const badMode = report.mode !== 'production';
  const badEnv = report.nodeEnv !== 'production' && report.nodeEnv !== '(unset)';
  if (badMode || badEnv) {
    die(
      `This build was produced with mode="${report.mode}", NODE_ENV="${report.nodeEnv}" — ` +
        'not a production build, so its sizes are not comparable to the budget.\n' +
        'Rebuild with NODE_ENV=production (pnpm run check:bundle-budget does this).',
    );
  }
}

/**
 * Human-readable diff of a chunk's composition against the budgeted baseline:
 * biggest growth first, marking additions and removals. Sizes are pre-minify
 * rendered bytes — good for naming the culprit, not for download math.
 */
function compositionDiffLines(current, baselineGroups) {
  if (!current) return ['  (module attribution unavailable — rerun the build)'];

  if (!baselineGroups) {
    const top = Object.entries(current)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([group, bytes]) => `  ${kib(bytes).padStart(10)}  ${group}`);
    return ['  Largest modules in this chunk (pre-minify bytes):', ...top];
  }

  const groups = new Set([...Object.keys(current), ...Object.keys(baselineGroups)]);
  const changes = [];
  for (const group of groups) {
    const now = current[group] ?? 0;
    const before = baselineGroups[group] ?? 0;
    if (now !== before) changes.push({ group, now, before, diff: now - before });
  }
  changes.sort((a, b) => b.diff - a.diff);

  const lines = [];
  for (const change of changes.slice(0, 10)) {
    const marker =
      change.before === 0 ? ' (new)' : change.now === 0 ? ' (removed)' : '';
    lines.push(
      `  ${delta(change.diff).padStart(10)}  ${change.group}${marker}` +
        (marker ? '' : ` (${kib(change.before)} → ${kib(change.now)})`),
    );
  }
  if (changes.length === 0) {
    lines.push('  (no module-level changes recorded — sizes shifted uniformly)');
  }
  return [
    '  Changes inside this chunk since the budget was set (pre-minify bytes):',
    ...lines,
  ];
}

// --------------------------------------------------------------------------
// 3. Discover the workspace route group: the workspace-routes chunk plus its
//    static import closure, minus chunks already on the critical path (those
//    are budgeted above — this group is what signed-in users download on top).
// --------------------------------------------------------------------------

const workspaceRootChunk = (report.chunks ?? []).find(
  (chunk) => chunk.name === WORKSPACE_CHUNK_NAME,
);
if (!workspaceRootChunk) {
  die(
    `No chunk named "${WORKSPACE_CHUNK_NAME}" in ${rel(reportPath)}.\n` +
      'The signed-in workspace budget keys off that route chunk ' +
      '(src/routes/workspace-routes.tsx). If the route entry moved or was ' +
      'renamed on purpose, update scripts/check-bundle-budget.mjs to match.',
  );
}

const criticalFiles = new Set(critical.map((chunk) => chunk.fileName));

// Breadth-first walk over static imports only — the report's `imports` array
// excludes dynamic imports, so lazily-loaded pages stay out, exactly like the
// landing check. Critical-path chunks are walked through (their imports are
// preloaded too) but filtered out of the group below.
const closureFiles = [];
{
  const queue = [workspaceRootChunk.fileName];
  const visited = new Set();
  while (queue.length > 0) {
    const fileName = queue.shift();
    if (visited.has(fileName)) continue;
    visited.add(fileName);
    const recorded = reportChunksByFile.get(fileName);
    if (!recorded) {
      die(
        `${rel(reportPath)} says the workspace route group reaches ${fileName}, ` +
          'but that chunk is not recorded in the report itself.\n' +
          'The report is inconsistent — rerun the production build.',
      );
    }
    closureFiles.push(fileName);
    for (const imported of recorded.imports ?? []) queue.push(imported);
  }
}

const workspaceGroup = closureFiles
  .filter((fileName) => !criticalFiles.has(fileName))
  .map((fileName) => ({
    label: chunkLabel(fileName),
    fileName,
    filePath: path.join(distDir, ...fileName.split('/')),
  }));

{
  const seenGroup = new Map();
  for (const chunk of workspaceGroup) {
    if (seenGroup.has(chunk.label)) {
      die(
        `Two workspace-group chunks share the label "${chunk.label}": ` +
          `${seenGroup.get(chunk.label)} and ${chunk.fileName}.\n` +
          'The chunk graph changed shape; update bundle-budget.json (and this ' +
          'script if labels genuinely collide) deliberately.\n\n' +
          UPDATE_HINT,
      );
    }
    seenGroup.set(chunk.label, chunk.fileName);
  }
}

for (const chunk of workspaceGroup) {
  if (!existsSync(chunk.filePath)) {
    die(
      `${rel(reportPath)} references ${chunk.fileName}, which does not exist.\n` +
        'The dist output is stale or partial — rerun the production build.',
    );
  }
  const content = readFileSync(chunk.filePath);
  chunk.rawBytes = content.length;
  chunk.gzipBytes = gzipSync(content).length;
}

const workspaceTotalGzip = workspaceGroup.reduce(
  (sum, chunk) => sum + chunk.gzipBytes,
  0,
);
const workspaceComposition = compositionFor(workspaceGroup);

// --------------------------------------------------------------------------
// 4a. --update: rewrite the budget file from the current build.
// --------------------------------------------------------------------------

if (updateMode) {
  const chunks = {};
  const compositionBaseline = {};
  for (const chunk of critical) {
    chunks[chunk.label] = {
      file: chunk.fileName,
      rawBaselineBytes: chunk.rawBytes,
      gzipBaselineBytes: chunk.gzipBytes,
      gzipBudgetBytes: roundUpToKiB(chunk.gzipBytes * (1 + HEADROOM_RATIO)),
    };
    compositionBaseline[chunk.label] = Object.fromEntries(
      Object.entries(composition[chunk.label]).sort(([, a], [, b]) => b - a),
    );
  }

  const workspaceChunks = {};
  const workspaceCompositionBaseline = {};
  for (const chunk of workspaceGroup) {
    workspaceChunks[chunk.label] = {
      file: chunk.fileName,
      rawBaselineBytes: chunk.rawBytes,
      gzipBaselineBytes: chunk.gzipBytes,
      gzipBudgetBytes: roundUpToKiB(chunk.gzipBytes * (1 + HEADROOM_RATIO)),
    };
    workspaceCompositionBaseline[chunk.label] = Object.fromEntries(
      Object.entries(workspaceComposition[chunk.label]).sort(
        ([, a], [, b]) => b - a,
      ),
    );
  }

  const budget = {
    note: [
      'Gzip budgets for the JavaScript users must download before venom-desktop',
      'can render, enforced by scripts/check-bundle-budget.mjs after every',
      'production build.',
      '"chunks" is the landing critical path: the entry chunk plus every',
      'modulepreload chunk in the built index.html — what every visitor fetches',
      'before anything renders.',
      '"workspaceGroup" is what signed-in users additionally download before',
      'their first useful screen: the workspace-routes chunk plus its static',
      'import closure, excluding chunks already budgeted on the critical path.',
      `Budgets are the measured size plus ${Math.round(HEADROOM_RATIO * 100)}% headroom, rounded up to 1 KiB.`,
      'To accept deliberate growth, run',
      '`pnpm --filter @workspace/venom-desktop run update:bundle-budget`',
      'and commit this file. Never widen it to silence a failure you cannot explain.',
    ],
    generatedAt: new Date().toISOString(),
    totalGzipBaselineBytes: totalGzip,
    totalGzipBudgetBytes: roundUpToKiB(totalGzip * (1 + HEADROOM_RATIO)),
    chunks,
    composition: compositionBaseline,
    workspaceGroup: {
      totalGzipBaselineBytes: workspaceTotalGzip,
      totalGzipBudgetBytes: roundUpToKiB(
        workspaceTotalGzip * (1 + HEADROOM_RATIO),
      ),
      chunks: workspaceChunks,
      composition: workspaceCompositionBaseline,
    },
  };

  writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(`Wrote ${rel(budgetPath)}.`);
  console.log(
    `Landing critical path: ${critical.length} chunks, ${kib(totalGzip)} gzip measured, ` +
      `${kib(budget.totalGzipBudgetBytes)} total budget.`,
  );
  for (const chunk of critical) {
    console.log(
      `  ${chunk.label.padEnd(16)} ${kib(chunk.gzipBytes).padStart(10)} gzip` +
        `  (budget ${kib(chunks[chunk.label].gzipBudgetBytes)})  ${chunk.fileName}`,
    );
  }
  console.log(
    `Workspace route group: ${workspaceGroup.length} chunks, ${kib(workspaceTotalGzip)} gzip measured, ` +
      `${kib(budget.workspaceGroup.totalGzipBudgetBytes)} total budget.`,
  );
  for (const chunk of workspaceGroup) {
    console.log(
      `  ${chunk.label.padEnd(16)} ${kib(chunk.gzipBytes).padStart(10)} gzip` +
        `  (budget ${kib(workspaceChunks[chunk.label].gzipBudgetBytes)})  ${chunk.fileName}`,
    );
  }
  process.exit(0);
}

// --------------------------------------------------------------------------
// 4b. Default: verify the current build against the committed budget.
// --------------------------------------------------------------------------

if (!existsSync(budgetPath)) {
  die(
    `Missing ${rel(budgetPath)}.\n` +
      'Generate it once from a known-good build:\n' +
      '  pnpm --filter @workspace/venom-desktop run update:bundle-budget',
  );
}

const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
const failures = [];
const notes = [];

for (const chunk of critical) {
  const budgeted = budget.chunks?.[chunk.label];

  if (!budgeted) {
    const block = [
      `✗ NEW chunk on the critical path: ${chunk.fileName} ` +
        `("${chunk.label}", ${kib(chunk.gzipBytes)} gzip).`,
      '  It is fetched before anything renders because index.html preloads it —',
      '  something statically imported it from entry-reachable code, or a new',
      '  manualChunks group was added in vite.config.ts.',
      ...compositionDiffLines(composition[chunk.label], undefined),
    ];
    failures.push(block.join('\n'));
    continue;
  }

  if (chunk.gzipBytes > budgeted.gzipBudgetBytes) {
    const block = [
      `✗ ${chunk.label} (${chunk.fileName}) is ${kib(chunk.gzipBytes)} gzip — ` +
        `over its ${kib(budgeted.gzipBudgetBytes)} budget ` +
        `(${delta(chunk.gzipBytes - budgeted.gzipBaselineBytes)} since the budget was set).`,
      ...compositionDiffLines(
        composition[chunk.label],
        budget.composition?.[chunk.label],
      ),
    ];
    failures.push(block.join('\n'));
  }
}

const budgetedLabels = Object.keys(budget.chunks ?? {});
const presentLabels = new Set(critical.map((chunk) => chunk.label));
const missing = budgetedLabels.filter((label) => !presentLabels.has(label));
if (missing.length > 0) {
  notes.push(
    `Budgeted chunk(s) no longer on the critical path: ${missing.join(', ')}. ` +
      'Nice — consider ratcheting the budget down (update:bundle-budget).',
  );
}

if (
  typeof budget.totalGzipBudgetBytes === 'number' &&
  totalGzip > budget.totalGzipBudgetBytes
) {
  const lines = critical.map((chunk) => {
    const baseline = budget.chunks?.[chunk.label]?.gzipBaselineBytes;
    const change =
      typeof baseline === 'number'
        ? ` (${delta(chunk.gzipBytes - baseline)} since budget)`
        : ' (not in budget)';
    return `    ${chunk.label.padEnd(16)} ${kib(chunk.gzipBytes).padStart(10)}${change}`;
  });
  failures.push(
    [
      `✗ Critical-path total is ${kib(totalGzip)} gzip — over the ` +
        `${kib(budget.totalGzipBudgetBytes)} total budget ` +
        `(baseline ${kib(budget.totalGzipBaselineBytes ?? 0)}).`,
      ...lines,
    ].join('\n'),
  );
}

// ---- Workspace route group ------------------------------------------------

const workspaceBudget = budget.workspaceGroup;
if (!workspaceBudget?.chunks) {
  failures.push(
    [
      `✗ ${rel(budgetPath)} has no "workspaceGroup" section, so the signed-in`,
      '  workspace route group is unguarded. Regenerate the budget from a',
      '  known-good build:',
      '  pnpm --filter @workspace/venom-desktop run update:bundle-budget',
    ].join('\n'),
  );
} else {
  for (const chunk of workspaceGroup) {
    const budgeted = workspaceBudget.chunks?.[chunk.label];

    if (!budgeted) {
      const block = [
        `✗ NEW chunk in the workspace route group: ${chunk.fileName} ` +
          `("${chunk.label}", ${kib(chunk.gzipBytes)} gzip).`,
        '  Signed-in users must download it before the workspace renders because',
        `  ${WORKSPACE_CHUNK_NAME} (or a chunk it statically imports) now imports it.`,
        ...compositionDiffLines(workspaceComposition?.[chunk.label], undefined),
      ];
      failures.push(block.join('\n'));
      continue;
    }

    if (chunk.gzipBytes > budgeted.gzipBudgetBytes) {
      const block = [
        `✗ ${chunk.label} (${chunk.fileName}) is ${kib(chunk.gzipBytes)} gzip — ` +
          `over its ${kib(budgeted.gzipBudgetBytes)} workspace-group budget ` +
          `(${delta(chunk.gzipBytes - budgeted.gzipBaselineBytes)} since the budget was set).`,
        ...compositionDiffLines(
          workspaceComposition?.[chunk.label],
          workspaceBudget.composition?.[chunk.label],
        ),
      ];
      failures.push(block.join('\n'));
    }
  }

  const workspaceBudgetedLabels = Object.keys(workspaceBudget.chunks ?? {});
  const workspacePresent = new Set(workspaceGroup.map((chunk) => chunk.label));
  const workspaceMissing = workspaceBudgetedLabels.filter(
    (label) => !workspacePresent.has(label),
  );
  if (workspaceMissing.length > 0) {
    notes.push(
      `Budgeted chunk(s) no longer in the workspace route group: ${workspaceMissing.join(', ')}. ` +
        'Nice — consider ratcheting the budget down (update:bundle-budget).',
    );
  }

  if (
    typeof workspaceBudget.totalGzipBudgetBytes === 'number' &&
    workspaceTotalGzip > workspaceBudget.totalGzipBudgetBytes
  ) {
    const lines = workspaceGroup.map((chunk) => {
      const baseline = workspaceBudget.chunks?.[chunk.label]?.gzipBaselineBytes;
      const change =
        typeof baseline === 'number'
          ? ` (${delta(chunk.gzipBytes - baseline)} since budget)`
          : ' (not in budget)';
      return `    ${chunk.label.padEnd(16)} ${kib(chunk.gzipBytes).padStart(10)}${change}`;
    });
    failures.push(
      [
        `✗ Workspace route group total is ${kib(workspaceTotalGzip)} gzip — over the ` +
          `${kib(workspaceBudget.totalGzipBudgetBytes)} total budget ` +
          `(baseline ${kib(workspaceBudget.totalGzipBaselineBytes ?? 0)}).`,
        ...lines,
      ].join('\n'),
    );
  }
}

for (const note of notes) console.log(`Note: ${note}`);

if (failures.length > 0) {
  console.error(
    `\nJavaScript budget check FAILED ` +
      `(landing critical path: ${critical.length} chunks, ${kib(totalGzip)} gzip; ` +
      `workspace route group: ${workspaceGroup.length} chunks, ${kib(workspaceTotalGzip)} gzip):\n`,
  );
  for (const block of failures) console.error(`${block}\n`);
  console.error(
    'Fix: find the static import that pulled this onto the critical path (or\n' +
      'into the workspace route group) and make it lazy (dynamic import), or\n' +
      'move it out of entry-reachable / workspace-reachable code.\n\n' +
      UPDATE_HINT,
  );
  process.exit(1);
}

console.log(
  `✓ Critical-path JS within budget: ${kib(totalGzip)} gzip of ` +
    `${kib(budget.totalGzipBudgetBytes ?? 0)} total budget.`,
);
for (const chunk of critical) {
  const budgeted = budget.chunks?.[chunk.label];
  console.log(
    `  ${chunk.label.padEnd(16)} ${kib(chunk.gzipBytes).padStart(10)} gzip` +
      (budgeted ? `  (budget ${kib(budgeted.gzipBudgetBytes)})` : ''),
  );
}
console.log(
  `✓ Workspace route group JS within budget: ${kib(workspaceTotalGzip)} gzip of ` +
    `${kib(workspaceBudget?.totalGzipBudgetBytes ?? 0)} total budget.`,
);
for (const chunk of workspaceGroup) {
  const budgeted = workspaceBudget?.chunks?.[chunk.label];
  console.log(
    `  ${chunk.label.padEnd(16)} ${kib(chunk.gzipBytes).padStart(10)} gzip` +
      (budgeted ? `  (budget ${kib(budgeted.gzipBudgetBytes)})` : ''),
  );
}
