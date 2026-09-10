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
};
const original = createRom();
const patch = makeZip({ 'data/hello.txt': 'browser patch\n' });
const actual = api.patchBuffer(original, patch);
const expected = patchBuffer(original, patch);
assert.equal(actual.returnValue, 'SUCCESS');
assert.equal(actual.outputMd5, expected.outputMd5);
assert.ok(Buffer.from(actual.buffer).equals(expected.buffer));
assert.equal(api.inspectRom(original).gameCode, 'TST0');
assert.throws(() => api.patchBuffer(original, new Uint8Array([1, 2])), /ZIP/);
console.log('Browser entry works without Node globals; patch output matches native Node');
