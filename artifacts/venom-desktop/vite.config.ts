import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

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
 * Adding a route-only package would drag it back onto the critical path.
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

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
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
});
