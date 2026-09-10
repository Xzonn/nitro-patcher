import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeXdelta } from '../src/patch/xdelta';

const header = Buffer.from([0xd6, 0xc3, 0xc4, 0, 0]);
function vint(n: number) {
  const a: number[] = [n % 128];
  while ((n = Math.floor(n / 128))) a.unshift((n % 128) | 128);
  return a;
}
interface WindowOptions {
  data?: number[];
  inst?: number[];
  addr?: number[];
  size: number;
  flags?: number;
  sourceSize?: number;
  offset?: number;
  checksum?: number[];
}
function window({
  data = [],
  inst = [],
  addr = [],
  size,
  flags = 0,
  sourceSize = 0,
  offset = 0,
  checksum,
}: WindowOptions) {
  const body = [
    ...vint(size),
    0,
    ...vint(data.length),
    ...vint(inst.length),
    ...vint(addr.length),
    ...(checksum ?? []),
    ...data,
    ...inst,
    ...addr,
  ];
  return Buffer.from([
    flags,
    ...(flags & 3 ? [...vint(sourceSize), ...vint(offset)] : []),
    ...vint(body.length),
    ...body,
  ]);
}
const patch = (...windows: Buffer[]) => Buffer.concat([header, ...windows]);

test('independent literal VCDIFF vector decodes Hello', () => {
  assert.equal(
    decodeXdelta(
      Buffer.alloc(0),
      Buffer.from('d6c3c40000000b050005010048656c6c6f06', 'hex'),
    ).toString(),
    'Hello',
  );
});
test('ADD and overlapping COPY repeat newly produced bytes', () => {
  const p = patch(window({ size: 9, data: [97, 98, 99], inst: [4, 19, 6], addr: [0] }));
  assert.equal(decodeXdelta(new Uint8Array(), p).toString(), 'abcabcabc');
});
test('RUN expands one literal and source COPY reads selected offset', () => {
  const p = patch(
    window({
      flags: 1,
      sourceSize: 3,
      offset: 2,
      size: 8,
      data: [33],
      inst: [19, 3, 0, 5],
      addr: [0],
    }),
  );
  assert.equal(decodeXdelta(Buffer.from('__abc__'), p).toString(), 'abc!!!!!');
});
test('VCD_TARGET uses previous windows, then crosses into current target bytes', () => {
  const p = patch(
    window({ size: 3, data: [97, 98, 99], inst: [4] }),
    window({ flags: 2, sourceSize: 2, offset: 1, size: 6, inst: [19, 6], addr: [0] }),
  );
  assert.equal(decodeXdelta(Buffer.alloc(0), p).toString(), 'abcbcbcbc');
});
test('HERE, all NEAR slots, and all SAME banks resolve cached source addresses', () => {
  const source = Buffer.from(Array.from({ length: 800 }, (_, i) => i % 251));
  const copies = [1, 257, 513, 7, 1, 257, 513, 7, 1, 257, 513, 799];
  const inst = [
    19, 1, 19, 1, 19, 1, 19, 1, 51, 1, 67, 1, 83, 1, 99, 1, 115, 1, 131, 1, 147, 1, 35, 1,
  ];
  const addr = [
    ...vint(1),
    ...vint(257),
    ...vint(513),
    ...vint(7),
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    ...vint(12),
  ];
  assert.deepEqual(
    decodeXdelta(source, patch(window({ flags: 1, sourceSize: 800, size: 12, inst, addr }))),
    Buffer.from(copies.map((i) => source[i]!)),
  );
});
test('paired ADD/COPY and COPY/ADD opcodes decode in order', () => {
  const p = patch(
    window({ flags: 1, sourceSize: 4, size: 10, data: [33, 63], inst: [163, 247], addr: [0, 0] }),
  );
  assert.equal(decodeXdelta(Buffer.from('abcd'), p).toString(), '!abcdabcd?');
});
test('application headers and Adler32 extension are supported', () => {
  const w = window({
    size: 5,
    flags: 4,
    checksum: [5, 140, 1, 245],
    data: [...Buffer.from('Hello')],
    inst: [6],
  });
  const p = Buffer.concat([Buffer.from([0xd6, 0xc3, 0xc4, 0, 4, 3, 97, 112, 112]), w]);
  assert.equal(decodeXdelta(Buffer.alloc(0), p).toString(), 'Hello');
  p[p.length - 2] = p[p.length - 2]! ^ 1;
  assert.throws(() => decodeXdelta(Buffer.alloc(0), p), /checksum/i);
});
test('rejects truncated streams and malformed lengths without partial output', () => {
  const p = patch(window({ size: 5, data: [...Buffer.from('Hello')], inst: [6] }));
  for (let i = 0; i < p.length; i++) {
    if (i !== header.length)
      assert.throws(() => decodeXdelta(Buffer.alloc(0), p.subarray(0, i)), /VCDIFF/);
  }
  assert.throws(
    () => decodeXdelta(Buffer.alloc(0), patch(window({ size: 2, data: [1], inst: [2] }))),
    /length|size|target/i,
  );
  assert.throws(
    () => decodeXdelta(Buffer.alloc(0), patch(window({ size: 1, inst: [19, 1], addr: [0] }))),
    /address|COPY/i,
  );
  assert.throws(
    () => decodeXdelta(Buffer.alloc(0), patch(window({ size: 1, data: [1, 2], inst: [2] }))),
    /unused|section/i,
  );
});
test('enforces output/window budgets before allocation', () => {
  const p = patch(window({ size: 1000000 }));
  assert.throws(() => decodeXdelta(Buffer.alloc(0), p, { maxOutputSize: 100 }), /limit|maximum/i);
  assert.throws(() => decodeXdelta(Buffer.alloc(0), p, { maxWindowSize: 100 }), /limit|maximum/i);
});
test('explicitly rejects unsupported compression, custom tables, versions and indicator bits', () => {
  for (const [h, message] of [
    [1, /secondary compression/i],
    [2, /code table/i],
    [8, /indicator/i],
  ] as const) {
    assert.throws(
      () => decodeXdelta(Buffer.alloc(0), Buffer.from([0xd6, 0xc3, 0xc4, 0, h])),
      message,
    );
  }
  assert.throws(
    () => decodeXdelta(Buffer.alloc(0), Buffer.from([0xd6, 0xc3, 0xc4, 1, 0])),
    /version/i,
  );
  assert.throws(
    () => decodeXdelta(Buffer.alloc(0), patch(window({ flags: 3, size: 0 }))),
    /indicator|source/i,
  );
});

test('genuine xdelta3 fixtures decode source-backed multiple windows and sourceless streams', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = (name: string) => readFile(new URL(`./fixtures/xdelta/${name}`, import.meta.url));
  const source = await fixture('source.bin'),
    expected = await fixture('target.bin');
  assert.deepEqual(decodeXdelta(source, await fixture('multiwindow.xdelta')), expected);
  assert.deepEqual(decodeXdelta(Buffer.alloc(0), await fixture('sourceless.xdelta')), expected);
  const corruptedSource = Buffer.from(source);
  corruptedSource[42] = corruptedSource[42]! ^ 1;
  const multiwindow = await fixture('multiwindow.xdelta');
  assert.throws(() => decodeXdelta(corruptedSource, multiwindow), /checksum/i);
  const compressed = await fixture('secondary-djw.xdelta');
  assert.throws(() => decodeXdelta(source, compressed), /secondary compression/i);
});
