import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const cjsPath = path.resolve(dirname, '../dist/index.cjs');
const esmPath = path.resolve(dirname, '../dist/index.js');

const EXPECTED_EXPORTS = [
  'AIAgentProvider',
  'useAgent',
  'registerTool',
  'openAIAdapter',
  'claudeAdapter',
  'AdapterError',
  'validateToolArgs',
];

describe.skipIf(!existsSync(cjsPath))('built package', () => {
  it('exposes the main exports from the CJS build', () => {
    const built = require(cjsPath);

    for (const name of EXPECTED_EXPORTS) {
      expect(
        built[name],
        `expected CJS export "${name}" to be defined`,
      ).toBeDefined();
    }
  });

  it('exposes the main exports from the ESM build', async () => {
    const built = await import(esmPath);

    for (const name of EXPECTED_EXPORTS) {
      expect(
        built[name],
        `expected ESM export "${name}" to be defined`,
      ).toBeDefined();
    }
  });

  it('starts the CJS build with the "use client" directive', () => {
    const source = readFileSync(cjsPath, 'utf8');
    expect(source.startsWith("'use client';")).toBe(true);
  });

  it('starts the ESM build with the "use client" directive', () => {
    const source = readFileSync(esmPath, 'utf8');
    expect(source.startsWith("'use client';")).toBe(true);
  });
});
