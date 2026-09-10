import test from 'node:test';
import assert from 'node:assert/strict';
import { createRom } from './fixtures';

test('NDSFile reads nested filesystem and repacks growing and shrinking replacements', async () => {
  const { NDSFile } = await import('../src/nitro/nds-file');
  const input = createRom({ hello: 'hello original', item: 'nested data' });
  const rom = new NDSFile(input);
  assert.equal(rom.getFile('data/hello.txt').toString(), 'hello original');
  assert.equal(rom.getFile('data/sub/item.bin').toString(), 'nested data');
  rom.replaceFile('data/hello.txt', Buffer.alloc(1500, 0x61));
  rom.replaceFile('data/sub/item.bin', Buffer.from('x'));
  const output = rom.toBuffer();
  const reread = new NDSFile(output);
  assert.deepEqual(reread.getFile('data/hello.txt'), Buffer.alloc(1500, 0x61));
  assert.equal(reread.getFile('data/sub/item.bin').toString(), 'x');
  assert.equal(reread.header.headerCRC, true);
  assert.equal(reread.header.secureCRC, true);
  assert.equal(reread.banner.bannerCRC, true);
  assert.deepEqual(rom.toBuffer(), output, 'serialization is repeatable');
  assert.throws(() => rom.replaceFile('data/new.txt', Buffer.alloc(0)), /not found/i);
});

test('overlays retain identity and data after repacking', async () => {
  const { NDSFile } = await import('../src/nitro/nds-file');
  const rom = new NDSFile(createRom({ overlay: Buffer.from('overlay old') }));
  const overlay = rom.listFiles().find((f) => f.path.startsWith('overlay/'));
  assert.ok(overlay);
  rom.replaceFile(overlay.path, Buffer.alloc(1025, 0x66));
  const output = new NDSFile(rom.toBuffer());
  assert.deepEqual(output.getFile(overlay.path), Buffer.alloc(1025, 0x66));
});

test('malformed ROM offsets and recursive directory trees are rejected', async () => {
  const { NDSFile } = await import('../src/nitro/nds-file');
  const invalid = createRom();
  invalid.writeUInt32LE(0xfffffff0, 0x48);
  assert.throws(() => new NDSFile(invalid), /FAT|range/i);
  const recursive = createRom();
  const fnt = recursive.readUInt32LE(0x40);
  const start = fnt + recursive.readUInt32LE(fnt);
  let p = start;
  while (recursive[p] && recursive[p] < 0x80) p += recursive[p] + 1;
  assert.ok(recursive[p] > 0x80);
  recursive.writeUInt16LE(0xf000, p + 1 + (recursive[p] & 0x7f));
  assert.throws(() => new NDSFile(recursive), /directory|cycle/i);
});
