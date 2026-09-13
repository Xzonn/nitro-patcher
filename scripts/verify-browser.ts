import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { patchBuffer } from '../src/nitro-patch-helper';
import { createRom, makeZip } from '../test/fixtures';
const metadata = JSON.parse(await readFile('package.json', 'utf8')) as {
  exports: Record<string, unknown>;
};
assert.ok(metadata.exports['./browser'], 'The package must expose a browser entry');
const source = await readFile('dist/browser.js', 'utf8');
assert.doesNotMatch(source, /(?:from|import\()\s*['"]node:/);
const declarations = await readFile('dist/browser.d.ts', 'utf8');
for (const match of declarations.matchAll(/(?:from\s+|import\()\s*['"](\.[^'"]+)['"]/g)) {
  assert.match(
    match[1]!,
    /\.(?:c|m)?js$/,
    `Browser declaration has an extensionless relative import: ${match[1]}`,
  );
}
const compiled = await transform(source, {
  format: 'iife',
  globalName: 'NitroBrowser',
  target: 'es2022',
});
const api = runInNewContext(`${compiled.code}\nNitroBrowser`, {
  TextDecoder,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  DataView,
  console,
}) as {
  patchBuffer: (
    rom: Uint8Array,
    patch: Uint8Array,
  ) => { buffer: Uint8Array; outputMd5: string; returnValue: string };
  inspectRom: (rom: Uint8Array) => { gameCode: string; fileCount: number };
  readPatchMetadata: (patch: Uint8Array) => { name?: string; isBeta?: boolean } | null;
};
const original = createRom();
const patchMetadata = {
  id: 'browser-patch',
  author: 'Example Team',
  name: 'Browser Patch',
  homepage: 'https://example.com',
  version: '1.0.0',
  isBeta: false,
};
const patch = makeZip({
  'data/hello.txt': 'browser patch\n',
  'metadata.json': JSON.stringify(patchMetadata),
});
const actual = api.patchBuffer(original, patch);
const expected = patchBuffer(original, patch);
assert.equal(actual.returnValue, 'SUCCESS');
assert.equal(actual.outputMd5, expected.outputMd5);
assert.ok(Buffer.from(actual.buffer).equals(expected.buffer));
assert.equal(api.inspectRom(original).gameCode, 'TST0');
assert.equal(JSON.stringify(api.readPatchMetadata(patch)), JSON.stringify(patchMetadata));
assert.throws(() => api.patchBuffer(original, new Uint8Array([1, 2])), /ZIP/);
console.log('Browser entry works without Node globals; patch output matches native Node');
