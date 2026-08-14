// The seam rule (1.3): nothing outside src/api calls a Facilio action or
// touches the Vibe SDK. This test makes the rule mechanical instead of a
// code-review hope.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    // .js/.jsx too: the 3D estate arrived with hand-written JavaScript
    // (buildEstate.js, planAssignments.js). Scanning only TypeScript would have
    // left this rule silently green while it stopped covering that whole surface.
    return /\.(ts|tsx|js|jsx)$/.test(name) ? [full] : [];
  });
}

describe('provider seam', () => {
  it('no SDK usage or action calls outside src/api', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      const topDir = rel.split(sep)[0];
      if (topDir === 'api' || topDir === '__tests__') continue;

      const text = readFileSync(file, 'utf8');
      if (text.includes('@facilio/vibe-sdk') || text.includes('executeAction')) {
        offenders.push(rel);
      }
    }

    expect(offenders, `SDK/action usage leaked outside src/api: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });
});
