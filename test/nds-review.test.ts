import test from 'node:test';
import assert from 'node:assert/strict';
import { NDSFile } from '../src/nitro-helper';
import { createRom } from './fixtures';

test('repacking preserves FAT entries that have no filename or overlay', () => {
  const source = createRom();
  const fatOffset = source.readUInt32LE(0x48);
  source.writeUInt32LE(24, 0x4c);
  source.writeUInt32LE(0x1f000, fatOffset + 16);
  source.writeUInt32LE(0x1f006, fatOffset + 20);
  source.write('HIDDEN', 0x1f000);
  const rom = new NDSFile(source);
  const output = rom.toBuffer();
  const reopened = new NDSFile(output);
  const hidden = reopened.fatTable.entries[2];
  assert.equal(hidden.size, 6);
  assert.equal(output.subarray(hidden.offset, hidden.offset + hidden.size).toString(), 'HIDDEN');
});

test('replacing ARM9 without the old Nitrocode footer keeps the complete executable size', () => {
  const rom = new NDSFile(createRom({ nitrocode: true }));
  const replacement = Buffer.alloc(0x4100, 0x7a);
  rom.replaceFile('arm9.bin', replacement);
  const reopened = new NDSFile(rom.toBuffer());
  assert.equal(reopened.header.ARM9size, replacement.length);
  assert.equal(reopened.header.nitrocode, false);
  assert.deepEqual(reopened.getFile('arm9.bin'), replacement);
});

test('replacing ARM9 with a Nitrocode footer excludes exactly its twelve bytes', () => {
  const rom = new NDSFile(createRom());
  const replacement = Buffer.alloc(0x410c, 0x7a);
  replacement.writeUInt32LE(0xdec00621, replacement.length - 12);
  rom.replaceFile('arm9.bin', replacement);
  const reopened = new NDSFile(rom.toBuffer());
  assert.equal(reopened.header.ARM9size, replacement.length - 12);
  assert.equal(reopened.header.nitrocode, true);
  assert.deepEqual(reopened.getFile('arm9.bin'), replacement);
});

test('secure-area CRC reflects the replacement ARM9 encryption state', () => {
  for (const decryptedInput of [false, true]) {
    const originalArm9 = Buffer.alloc(0x4000, 0x31);
    if (decryptedInput) originalArm9.writeBigUInt64LE(0xe7ffdeffe7ffdeffn);
    const rom = new NDSFile(createRom({ arm9: originalArm9 }));
    const replacement = Buffer.alloc(0x4000, 0x42);
    if (!decryptedInput) replacement.writeBigUInt64LE(0xe7ffdeffe7ffdeffn);
    rom.replaceFile('arm9.bin', replacement);
    const reopened = new NDSFile(rom.toBuffer());
    assert.equal(reopened.header.decrypted, !decryptedInput);
    assert.equal(reopened.header.secureCRC, true);
  }
});
