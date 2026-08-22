import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

/**
 * Split the three largest always-needed vendors out of the entry chunk.
 *
 * Route-level `import()` already keeps page code off the first load, but every
 * route still needs React, Clerk and Motion, so Rollup would otherwise inline
 * all three into a single ~550 kB entry file. As separate chunks the browser
 * fetches them in parallel and keeps them cached across deploys, since they
 * only change when the dependency itself changes.
 *
 * Only packages that are already reachable from the entry are listed here.
 * Adding a route-only package would drag it back onto the critical path —
 * scripts/check-bundle-budget.mjs fails the build when that happens.
 */
function vendorChunk(id: string): string | undefined {
  const marker = 'node_modules/';
  const index = id.lastIndexOf(marker);
  if (index === -1) return undefined;

  const subpath = id.slice(index + marker.length);
  const segments = subpath.split('/');
  const pkg = subpath.startsWith('@')
    ? `${segments[0]}/${segments[1]}`
    : segments[0];

  if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') {
    return 'vendor-react';
  }
  if (pkg.startsWith('@clerk/')) return 'vendor-clerk';
  if (pkg === 'framer-motion' || pkg.startsWith('motion-')) {
    return 'vendor-motion';
  }
  return undefined;
}

const artifactRoot = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * Make module ids stable across machines so the composition report (and the
 * budget baseline derived from it) can be compared between local builds and
 * CI: package code becomes `npm:<subpath>`, workspace code becomes a
 * repo-relative path, Rollup/Vite synthetic modules become `virtual:<id>`.
 */
function normalizeModuleId(id: string): string {
  let cleaned = id;
  let virtual = false;
  if (cleaned.startsWith('\0')) {
    virtual = true;
    cleaned = cleaned.slice(1);
  }

  const marker = 'node_modules/';
  const index = cleaned.lastIndexOf(marker);
  if (index !== -1) return `npm:${cleaned.slice(index + marker.length)}`;
  if (virtual) return `virtual:${cleaned}`;

  if (cleaned.startsWith(artifactRoot + path.sep)) {
    return path.relative(artifactRoot, cleaned).split(path.sep).join('/');
  }
  if (cleaned.startsWith(repoRoot + path.sep)) {
    return path.relative(repoRoot, cleaned).split(path.sep).join('/');
  }
  return cleaned;
}

/**
 * Record what every emitted JS chunk is made of.
 *
 * The report lands at dist/bundle-composition.json — next to, not inside, the
 * served dist/public output — and is what lets the critical-path budget check
 * (scripts/check-bundle-budget.mjs) say *which module* grew instead of just
 * "the entry chunk is bigger". `renderedLength` is measured before
 * minification, so the numbers are for attribution, not download size.
 */
function bundleCompositionReport(): Plugin {
  const reportPath = path.join(artifactRoot, 'dist', 'bundle-composition.json');
  let mode = 'unknown';
  let nodeEnv = 'unknown';

  return {
    name: 'venom:bundle-composition-report',
    apply: 'build',
    configResolved(config) {
      mode = config.mode;
      nodeEnv = process.env.NODE_ENV ?? '(unset)';
    },
    generateBundle(_options, bundle) {
      const chunks = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        const modules: Record<string, number> = {};
        for (const [id, mod] of Object.entries(output.modules)) {
          const key = normalizeModuleId(id);
          modules[key] = (modules[key] ?? 0) + mod.renderedLength;
        }
        chunks.push({
          fileName,
          name: output.name,
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          imports: output.imports,
          modules,
        });
      }

      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        JSON.stringify(
          { mode, nodeEnv, generatedAt: new Date().toISOString(), chunks },
          null,
          2,
        ),
      );
    },
  };
}

export default defineConfig(async ({ command }) => ({
  base: basePath,
  plugins: [
    react(),
    // Default options on purpose: during `vite build` the plugin runs its
    // Lightning CSS optimize/minify pass on the emitted stylesheet (dev serve
    // never optimizes either way). The stylesheet is the one render-blocking
    // file on first paint, so don't pass `optimize: false` here — that ships
    // a meaningfully larger CSS download to every visitor.
    tailwindcss(),
    runtimeErrorOverlay(),
    // Dev-only tooling is gated on `command` (not just NODE_ENV) so that a
    // production build measures the same bundle no matter what environment it
    // runs in — the bundle-budget check depends on builds being deterministic.
    ...(command === 'serve' &&
    process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
    bundleCompositionReport(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
}));
