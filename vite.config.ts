import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname does not exist in an ESM config; derive it rather than relying on
// a bundler shim.
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const BUILD_ID = new Date().toISOString().slice(5, 16).replace('T', ' ');

/**
 * Dev-only: serve the estate record fixtures at /__fixtures__/<name>.json so the
 * 3D harness (?harness=1) can boot the real screen with no Facilio session.
 * `apply: 'serve'` keeps the 152 KB out of every build.
 */
function fixtureServer(): Plugin {
  return {
    name: 'estate-fixture-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/__fixtures__\/([\w.-]+\.json)$/.exec((req.url ?? '').split('?')[0]);
        if (!match) return next();
        const file = path.resolve(ROOT, 'fixtures', match[1]);
        if (!fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end('not found');
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(fs.readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  // Consumed at src/screens/SurveysScreen.tsx — dropping this define keeps tsc
  // and vite build green and throws only in the browser, on that one screen.
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), fixtureServer()],
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    globals: false,
    /**
     * vitest defaults to 5 s per test. That is not enough for the AR suites, and
     * not because anything is slow in production: the presence-decay test alone
     * allows its own `waitFor` 4 s, so a boot plus a scan plus that retry nearly
     * exhausts the budget before contention is considered — and 44 test files run
     * in parallel.
     *
     * Measured, not guessed: the captured failure is literally "Test timed out in
     * 5000ms", and the AR maintenance loop takes ~1.8 s of its budget when the
     * machine is idle. This does not weaken any assertion; a genuinely broken
     * path still fails, and now says what was missing instead of just "timed out".
     */
    testTimeout: 20_000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/fixtures/**'],
  },
});
