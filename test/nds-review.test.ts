import assert from "node:assert/strict";
import test from "node:test";

import { createRom } from "./fixtures";
import { NDSFile } from "../src/nitro-helper";

test("repacking preserves FAT entries that have no filename or overlay", () => {
  const source = createRom();
  const fatOffset = source.readUInt32LE(0x48);
  source.writeUInt32LE(24, 0x4c);
  source.writeUInt32LE(0x1f000, fatOffset + 16);
  source.writeUInt32LE(0x1f006, fatOffset + 20);
  source.write("HIDDEN", 0x1f000);
  const rom = new NDSFile(source);
  const output = rom.toBuffer();
  const reopened = new NDSFile(output);
  const hidden = reopened.fatTable.entries[2];
  assert.equal(hidden.size, 6);
  assert.equal(output.subarray(hidden.offset, hidden.offset + hidden.size).toString(), "HIDDEN");
});

test("replacing ARM9 without the old Nitrocode footer keeps the complete executable size", () => {
  const rom = new NDSFile(createRom({ nitrocode: true }));
  const replacement = Buffer.alloc(0x4100, 0x7a);
  rom.replaceFile("arm9.bin", replacement);
  const reopened = new NDSFile(rom.toBuffer());
  assert.equal(reopened.header.ARM9size, replacement.length);
  assert.equal(reopened.header.nitrocode, false);
  assert.deepEqual(reopened.getFile("arm9.bin"), replacement);
});

test("replacing ARM9 with a Nitrocode footer excludes exactly its twelve bytes", () => {
  const rom = new NDSFile(createRom());
  const replacement = Buffer.alloc(0x410c, 0x7a);
  replacement.writeUInt32LE(0xdec00621, replacement.length - 12);
  rom.replaceFile("arm9.bin", replacement);
  const reopened = new NDSFile(rom.toBuffer());
  assert.equal(reopened.header.ARM9size, replacement.length - 12);
  assert.equal(reopened.header.nitrocode, true);
  assert.deepEqual(reopened.getFile("arm9.bin"), replacement);
});

test("secure-area CRC reflects the replacement ARM9 encryption state", () => {
  for (const decryptedInput of [false, true]) {
    const originalArm9 = Buffer.alloc(0x4000, 0x31);
    if (decryptedInput) originalArm9.writeBigUInt64LE(0xe7ffdeffe7ffdeffn);
    const rom = new NDSFile(createRom({ arm9: originalArm9 }));
    const replacement = Buffer.alloc(0x4000, 0x42);
    if (!decryptedInput) replacement.writeBigUInt64LE(0xe7ffdeffe7ffdeffn);
    rom.replaceFile("arm9.bin", replacement);
    const reopened = new NDSFile(rom.toBuffer());
    assert.equal(reopened.header.decrypted, !decryptedInput);
    assert.equal(reopened.header.secureCRC, true);
  }
});

test("additions remap both overlay tables, nonconsecutive IDs and unnamed allocations", () => {
  const source = createRom({ overlay: "arm9 overlay" });
  const fat = source.readUInt32LE(0x48);
  const fnt = source.readUInt32LE(0x40);
  // Put named files at source IDs 3 and 5, with ARM7 at ID 2 and two unnamed entries.
  source.copy(source, fat + 24, fat + 8, fat + 16);
  source.copy(source, fat + 40, fat + 16, fat + 24);
  source.writeUInt16LE(3, fnt + 4);
  source.writeUInt16LE(5, fnt + 12);
  source.writeUInt32LE(48, 0x4c);
  source.writeUInt32LE(0x1e000, fat + 8);
  source.writeUInt32LE(0x1e006, fat + 12);
  source.write("HIDDEN", 0x1e000);
  source.writeUInt32LE(0x1e200, fat + 16);
  source.writeUInt32LE(0x1e204, fat + 20);
  source.write("ARM7", 0x1e200);
  source.fill(0, fat + 32, fat + 40);
  const table7 = 0x1e400;
  source.fill(0, table7, table7 + 32);
  source.writeUInt32LE(7, table7);
  source.writeUInt32LE(2, table7 + 24);
  source.writeUInt32LE(0x01000004, table7 + 28);
  source.writeUInt32LE(table7, 0x58);
  source.writeUInt32LE(32, 0x5c);
  const rom = new NDSFile(source);
  const replacementTable = rom.getFile("overarm7.bin");
  replacementTable.writeUInt32LE(0x02345678, 4);
  rom.replaceFile("overarm7.bin", replacementTable);
  rom.replaceFile("overlay/overlay7_0007.bin", Buffer.from("ARM7 updated"));
  rom.addFile("data/A.bin", Buffer.from("new"));
  const output = rom.toBuffer();
  const reread = new NDSFile(output);
  assert.deepEqual(output, rom.toBuffer());
  assert.equal(reread.overlay9Table.entries[0].fileId, 0);
  assert.equal(reread.overlay7Table.entries[0].fileId, 1);
  assert.equal(reread.overlay7Table.entries[0].overlayId, 7);
  assert.equal(reread.overlay7Table.entries[0].ramAddress, 0x02345678);
  assert.equal(reread.overlay7Table.entries[0].reserved, 0x0100000c);
  assert.equal(reread.getFile("overlay/overlay7_0007.bin").toString(), "ARM7 updated");
  assert.equal(reread.getFile("overlay/overlay_0000.bin").toString(), "arm9 overlay");
  assert.equal(reread.getFile("data/hello.txt").toString(), rom.getFile("data/hello.txt").toString());
  assert.deepEqual(reread.getFile("data/sub/item.bin"), rom.getFile("data/sub/item.bin"));
  const hidden = reread.fatTable.entries[2];
  assert.equal(output.subarray(hidden.offset, hidden.offset + hidden.size).toString(), "HIDDEN");
  assert.equal(reread.fatTable.entries[3].size, 0);
  assert.equal(reread.fatTable.entries.length, 7);
});

test("a file shared by FNT and overlay has one output allocation with overlay content", () => {
  const source = createRom({ overlay: "unused overlay" });
  const table = source.readUInt32LE(0x50);
  source.writeUInt32LE(1, table + 24);
  source.writeUInt32LE(0x01000000, table + 28);
  const rom = new NDSFile(source);
  rom.replaceFile("data/hello.txt", Buffer.from("ordinary replacement"));
  rom.replaceFile("overlay/overlay_0000.bin", Buffer.from("overlay replacement"));
  rom.addFile("data/A.bin", Buffer.from("new"));
  const output = new NDSFile(rom.toBuffer());
  const file = output.listFiles().find(({ path }) => path === "data/hello.txt")!;
  assert.equal(file.id, output.overlay9Table.entries[0].fileId);
  assert.equal(output.fatTable.entries.length, 4);
  assert.equal(output.getFile("data/hello.txt").toString(), "overlay replacement");
  assert.equal(output.getFile("overlay/overlay_0000.bin").toString(), "overlay replacement");
  assert.equal(output.overlay9Table.entries[0].reserved, 0x01000013);
});

test("existing FNT filename bytes survive regeneration including noncanonical Shift_JIS", () => {
  const source = createRom();
  const fnt = source.readUInt32LE(0x40);
  // The decoder accepts invalid bytes as U+FFFD; preserve their original bytes.
  source[fnt + 17] = 0xff;
  source[fnt + 27] = 0xff;
  const rom = new NDSFile(source);
  const nameBytes = Buffer.from(rom.data.files[0].nameBytes!);
  const directory = rom.data.folders[0];
  const directoryBytes = Buffer.from(directory.nameBytes!);
  rom.addFile(`data/${directory.name}/New.bin`, Buffer.from("existing directory"));
  rom.addFile("data/New.bin", Buffer.alloc(0));
  const reread = new NDSFile(rom.toBuffer());
  assert.deepEqual(reread.data.files.find((file) => file.name === rom.data.files[0].name)?.nameBytes, nameBytes);
  assert.deepEqual(reread.data.folders.find((folder) => folder.name === directory.name)?.nameBytes, directoryBytes);
  assert.equal(reread.getFile(`data/${directory.name}/New.bin`).toString(), "existing directory");
});
