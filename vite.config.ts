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
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/fixtures/**'],
  },
});
