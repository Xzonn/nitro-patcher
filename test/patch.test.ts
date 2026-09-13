import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRom, makeZip } from './fixtures';

test('reads and validates patch metadata field by field', async () => {
  const { readPatchMetadata } = await import('../src/nitro-patch-helper');
  const expected = {
    id: 'example-patch',
    author: 'Example Team',
    name: 'Example Translation',
    homepage: 'https://example.com/patch',
    version: '1.2.3',
    isBeta: true,
  };

  assert.deepEqual(
    readPatchMetadata(makeZip({ 'MeTaDaTa.JsOn': JSON.stringify(expected) })),
    expected,
  );
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...arguments_) => warnings.push(arguments_);
  try {
    assert.equal(readPatchMetadata(makeZip({ 'md5.txt': '0'.repeat(32) })), null);
    assert.equal(warnings.length, 0);
    assert.equal(readPatchMetadata(makeZip({ 'metadata.json': '{' })), null);
    assert.deepEqual(
      readPatchMetadata(
        makeZip({ 'metadata.json': JSON.stringify({ ...expected, id: undefined }) }),
      ),
      {
        author: expected.author,
        name: expected.name,
        homepage: expected.homepage,
        version: expected.version,
        isBeta: expected.isBeta,
      },
    );
    assert.deepEqual(
      readPatchMetadata(
        makeZip({ 'metadata.json': JSON.stringify({ ...expected, isBeta: 'yes' }) }),
      ),
      {
        id: expected.id,
        author: expected.author,
        name: expected.name,
        homepage: expected.homepage,
        version: expected.version,
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 3);
  assert.match(String(warnings[0]?.[0]), /metadata\.json/);
  assert.match(String(warnings[1]?.[0]), /id/);
  assert.match(String(warnings[2]?.[0]), /isBeta/);
});

test('patch helper replaces case-insensitive paths, ignores extra files and returns original/output MD5', async () => {
  const { patchBuffer } = await import('../src/nitro-patch-helper');
  const { NDSFile } = await import('../src/nitro-helper');
  const input = createRom();
  const digest = createHash('md5').update(input).digest('hex');
  const result = patchBuffer(
    input,
    makeZip({
      'DATA/HELLO.TXT': 'patched',
      'data/new.txt': 'ignored',
      'md5.txt': `# comment\n${digest.toUpperCase()}\n`,
    }),
  );
  assert.equal(result.returnValue, 'SUCCESS');
  assert.equal(result.inputMd5, digest);
  assert.equal(result.outputMd5, createHash('md5').update(result.buffer).digest('hex'));
  const output = new NDSFile(result.buffer);
  assert.equal(output.getFile('data/hello.txt').toString(), 'patched');
  assert.equal(output.hasFile('data/new.txt'), false);
});

test('MD5 mismatch preserves existing output behavior; malformed list fails', async () => {
  const { patchBuffer } = await import('../src/nitro-patch-helper');
  const input = createRom();
  const result = patchBuffer(input, makeZip({ 'md5.txt': '0'.repeat(32) }));
  assert.equal(result.returnValue, 'MD5_MISMATCH');
  assert.ok(result.buffer.length);
  assert.throws(() => patchBuffer(input, makeZip({ 'md5.txt': 'bad checksum' })), /md5.txt/);
});

test('Xdelta overrides direct replacement and preprocessing uses original MD5', async () => {
  const { patchBuffer } = await import('../src/nitro-patch-helper');
  const { NDSFile } = await import('../src/nitro-helper');
  const vint = (value: number): number[] => {
    const out = [value & 127];
    while ((value = Math.floor(value / 128))) out.unshift((value & 127) | 128);
    return out;
  };
  const literal = (target: Buffer): Buffer => {
    const inst = Buffer.from([1, ...vint(target.length)]);
    const delta = Buffer.concat([
      Buffer.from([...vint(target.length), 0, ...vint(target.length), ...vint(inst.length), 0]),
      target,
      inst,
    ]);
    return Buffer.concat([Buffer.from([0xd6, 0xc3, 0xc4, 0, 0, 0, ...vint(delta.length)]), delta]);
  };
  const input = createRom(),
    preprocessed = createRom({ item: 'preprocessed' });
  const md5 = createHash('md5').update(input).digest('hex');
  const result = patchBuffer(
    input,
    makeZip({
      [`preprocessing/${md5}.xdelta`]: literal(preprocessed),
      'data/hello.txt': 'direct',
      'xdelta/data/hello.txt': literal(Buffer.from('delta')),
      'md5.txt': md5,
    }),
  );
  const rom = new NDSFile(result.buffer);
  assert.equal(result.returnValue, 'SUCCESS');
  assert.equal(rom.getFile('data/hello.txt').toString(), 'delta');
  assert.equal(rom.getFile('data/sub/item.bin').toString(), 'preprocessed');
});

test('output allocation and ZIP expansion limits apply across the patch pipeline', async () => {
  const { patchBuffer } = await import('../src/nitro-patch-helper');
  assert.throws(
    () =>
      patchBuffer(createRom(), makeZip({ 'data/hello.txt': 'too much' }), {
        maxUncompressedSize: 1,
      }),
    /limit|size/i,
  );
  assert.throws(() => patchBuffer(createRom(), makeZip({}), { maxOutputSize: 1024 }), /limit/i);
});
